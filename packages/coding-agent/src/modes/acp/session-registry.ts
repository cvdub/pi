/**
 * Maps ACP sessionIds to per-session pi runtimes.
 *
 * Each ACP session owns a full AgentSessionRuntime created from the factory
 * main.ts builds, wrapped so `toolsOptions` (fs/terminal delegation from
 * M3/M4) is injected into every runtime build — including the rebuilds that
 * extension-driven session replacement (/new, fork, /resume) performs. The
 * mandatory rebind pattern (see rpc-mode.ts) re-subscribes events,
 * re-binds extensions, and re-registers the backpressure hook after every
 * replacement; it is installed via `runtime.setRebindSession`.
 *
 * `session/new` and `session/load` differ only in where the pi session comes
 * from (freshly created vs. opened from disk and replayed) — they share handle
 * construction, binding, and the rebind hook, so a loaded session behaves
 * exactly like a created one from the first prompt onwards.
 */

import type { AgentSideConnection, AvailableCommand } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { resolvePath } from "../../utils/paths.ts";
import { AcpEventTranslator, PromptTurnTracker } from "./event-translator.ts";
import { createAcpExtensionUIContext } from "./extension-ui.ts";
import { streamSessionHistory } from "./history-replay.ts";
import { AcpToolCallMapper } from "./tool-call-mapper.ts";
import type { AcpAgentDeps, AcpSessionHandle, ClientCaps } from "./types.ts";

export class AcpSessionRegistry {
	private readonly connection: AgentSideConnection;
	private readonly deps: AcpAgentDeps;
	private readonly clientCaps: ClientCaps;
	private readonly sessions = new Map<string, AcpSessionHandle>();
	/** In-flight `session/load` calls, keyed by sessionId, so duplicates join instead of racing. */
	private readonly loadsInFlight = new Map<string, Promise<AcpSessionHandle>>();

	constructor(connection: AgentSideConnection, deps: AcpAgentDeps, clientCaps: ClientCaps) {
		this.connection = connection;
		this.deps = deps;
		this.clientCaps = clientCaps;
	}

	get(sessionId: string): AcpSessionHandle | undefined {
		return this.sessions.get(sessionId);
	}

	/** Look up a session or fail the request with a JSON-RPC error. */
	require(sessionId: string): AcpSessionHandle {
		const handle = this.sessions.get(sessionId);
		if (!handle) {
			throw RequestError.invalidParams({ sessionId }, `Unknown session: ${sessionId}`);
		}
		return handle;
	}

	/**
	 * Create a fresh pi session (and runtime) for `session/new`.
	 *
	 * The ACP sessionId is the pi SessionManager UUID, so the client's id maps
	 * directly onto the session file on disk.
	 */
	async createSession(options: { cwd: string }): Promise<AcpSessionHandle> {
		const cwd = resolvePath(options.cwd);
		const sessionManager = SessionManager.create(cwd, this.deps.sessionDir);
		const sessionId = sessionManager.getSessionId();

		const runtime = await createAgentSessionRuntime(this.wrapFactory(sessionId), {
			cwd,
			agentDir: this.deps.agentDir,
			sessionManager,
		});

		const handle = this.buildHandle(sessionId, runtime);
		await this.bindHandle(handle, { deferCommands: true });
		this.sessions.set(sessionId, handle);
		return handle;
	}

	/**
	 * Resume an existing pi session for `session/load`.
	 *
	 * The ACP sessionId is the pi session UUID, so the id is resolved straight
	 * to a session file on disk. The client's cwd is passed to
	 * `SessionManager.open` as an authoritative override: it is where the
	 * client is working now, and it keeps sessions whose original cwd has been
	 * deleted from throwing `MissingSessionCwdError`.
	 *
	 * The full history is streamed before this resolves (see
	 * {@link streamSessionHistory}) — the caller must not answer `session/load`
	 * until it does. Afterwards the handle is indistinguishable from one
	 * `createSession` produced: same shape, same rebind hook, same command set.
	 */
	async loadSession(options: { sessionId: string; cwd: string }): Promise<AcpSessionHandle> {
		// The SDK dispatches requests concurrently, and the `existing` check below
		// is followed by several awaits. Without this guard two simultaneous loads
		// of one id would both build a runtime, both replay, and the second
		// registration would orphan the first — leaking its runtime and
		// subscriptions and duplicating the transcript. Joining the in-flight load
		// makes a duplicate request a no-op instead.
		const inFlight = this.loadsInFlight.get(options.sessionId);
		if (inFlight) {
			return inFlight;
		}
		const load = this.loadSessionUncoordinated(options).finally(() => {
			this.loadsInFlight.delete(options.sessionId);
		});
		this.loadsInFlight.set(options.sessionId, load);
		return load;
	}

	private async loadSessionUncoordinated(options: { sessionId: string; cwd: string }): Promise<AcpSessionHandle> {
		const cwd = resolvePath(options.cwd);
		const existing = this.sessions.get(options.sessionId);
		if (existing) {
			// Already open on this connection: re-streaming the live session's
			// history is a resync, and is safer than tearing down a runtime that
			// may have a turn in flight. The handle keeps its original cwd — a
			// resync ignores the request's cwd.
			//
			// Known-degenerate while a turn is streaming: the replay interleaves
			// with live chunks on the same tail (they are indistinguishable to the
			// client), the in-flight turn's completed messages appear both live and
			// replayed, and the response waits for a stable tail. Emacs resumes in
			// a fresh process, so this path is not on the supported route; it is a
			// safe-ish fallback, not a designed behavior, and is untested.
			await this.replayHistory(existing);
			return existing;
		}

		const sessionPath = await this.resolveSessionPath(options.sessionId, cwd);
		if (!sessionPath) {
			throw RequestError.invalidParams({ sessionId: options.sessionId }, `Unknown session: ${options.sessionId}`);
		}
		const sessionManager = SessionManager.open(sessionPath, this.deps.sessionDir, cwd);
		const sessionId = sessionManager.getSessionId();
		if (sessionId !== options.sessionId) {
			// The ACP sessionId *is* the pi session id. A file that does not carry
			// the requested id (missing/corrupt header — SessionManager then mints
			// a fresh id) cannot serve this session: every notification would be
			// stamped with an id the client never asked for.
			throw RequestError.invalidParams({ sessionId: options.sessionId }, `Unknown session: ${options.sessionId}`);
		}

		const runtime = await createAgentSessionRuntime(this.wrapFactory(sessionId), {
			cwd,
			agentDir: this.deps.agentDir,
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "resume" },
		});

		const handle = this.buildHandle(sessionId, runtime);
		try {
			// Not deferred: the client already knows this session id (it sent it),
			// so the command set can go out ahead of the history.
			await this.bindHandle(handle);
			this.sessions.set(sessionId, handle);
			await this.replayHistory(handle);
		} catch (error) {
			this.sessions.delete(sessionId);
			handle.unsubscribe?.();
			handle.unsubscribeBackpressure?.();
			handle.toolCalls.dispose();
			await runtime.dispose().catch(() => {});
			throw error;
		}
		return handle;
	}

	/**
	 * Resolve an ACP sessionId (== pi session UUID) to its session file.
	 *
	 * The client's cwd is tried first (the common case, and the cheap lookup);
	 * the connection-wide listing is the fallback for a session started in a
	 * different — possibly since deleted — directory.
	 */
	private async resolveSessionPath(sessionId: string, cwd: string): Promise<string | undefined> {
		const scoped = await SessionManager.list(cwd, this.deps.sessionDir);
		const match = scoped.find((info) => info.id === sessionId);
		if (match) {
			return match.path;
		}
		const all = await SessionManager.listAll(this.deps.sessionDir);
		return all.find((info) => info.id === sessionId)?.path;
	}

	/** Stream the handle's current leaf-path history to the client, and wait for it to flush. */
	private async replayHistory(handle: AcpSessionHandle): Promise<void> {
		await streamSessionHistory({
			entries: handle.runtime.session.sessionManager.buildContextEntries(),
			cwd: handle.runtime.cwd,
			translator: handle.translator,
		});
	}

	/**
	 * Assemble the per-session state shared by `session/new` and `session/load`.
	 *
	 * Installs the mandatory rebind hook; the caller performs the initial bind
	 * (they differ only in whether the command set is deferred).
	 */
	private buildHandle(sessionId: string, runtime: AgentSessionRuntime): AcpSessionHandle {
		const tracker = new PromptTurnTracker();
		// The mapper feeds its updates back through the translator's ordered
		// delivery tail, so it is bound after the translator exists.
		let deliver: AcpEventTranslator | undefined;
		const toolCalls = new AcpToolCallMapper({
			sendUpdate: (update) => deliver?.sendUpdate(update),
			// `runtime.cwd` follows extension-driven session replacement.
			getCwd: () => runtime.cwd,
		});
		const translator = new AcpEventTranslator({
			sessionId,
			sendNotification: (notification) => this.connection.sessionUpdate(notification),
			tracker,
			// `runtime.session` always points at the current session, also after
			// extension-driven replacement.
			isSessionIdle: () => runtime.session.isIdle,
			toolEventSink: toolCalls,
		});
		deliver = translator;

		const handle: AcpSessionHandle = { sessionId, runtime, translator, prompts: tracker, toolCalls };
		// Mandatory rebind: after /new, fork, or /resume replaces the session,
		// re-bind extensions and re-subscribe — otherwise updates silently stop.
		runtime.setRebindSession(async () => {
			await this.bindHandle(handle);
		});
		return handle;
	}

	/**
	 * Wrap the app-level runtime factory so every runtime built for this ACP
	 * session — including rebuilds from /new and fork — carries the injected
	 * ToolsOptions (fs/terminal delegation in M3/M4).
	 */
	private wrapFactory(sessionId: string): CreateAgentSessionRuntimeFactory {
		return (factoryOptions) =>
			this.deps.createRuntime({
				...factoryOptions,
				toolsOptions: this.deps.createToolsOptions?.({
					sessionId,
					cwd: factoryOptions.cwd,
					connection: this.connection,
					clientCaps: this.clientCaps,
				}),
			});
	}

	private async bindHandle(handle: AcpSessionHandle, bindOptions: { deferCommands?: boolean } = {}): Promise<void> {
		const session = handle.runtime.session;
		// On a rebind the previous session's in-flight tool calls are gone; drop
		// their state so no throttled snapshot trails into the new session.
		handle.toolCalls.dispose();
		await session.bindExtensions({
			mode: "acp",
			// Rebuilt on every bind/rebind (never captured once) so it always
			// closes over the current handle's sessionId; the connection and
			// sessionId themselves don't change across a rebind, but the context
			// object is disposable per-bind by construction.
			uiContext: createAcpExtensionUIContext({ connection: this.connection, sessionId: handle.sessionId }),
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => handle.runtime.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await handle.runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return handle.runtime.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				this.deps.onShutdownRequested?.();
			},
			onError: (err) => {
				console.error(`ACP extension error (${err.extensionPath}, ${err.event}): ${err.error}`);
			},
		});

		handle.unsubscribe?.();
		handle.unsubscribeBackpressure?.();
		handle.unsubscribe = session.subscribe((event) => {
			handle.translator.handleEvent(event);
		});
		// Outbound backpressure: the agent awaits its subscribers, so awaiting
		// the translator's delivery tail here throttles the agent loop to the
		// client connection (and, over stdio, to real stdout backpressure).
		handle.unsubscribeBackpressure = session.agent.subscribe(async () => {
			await handle.translator.waitForDeliveries();
		});
		if (bindOptions.deferCommands) {
			// A brand new session id only reaches the client in the `session/new`
			// response, so let that response hit the wire before announcing the
			// command set (the ordering the ACP SDK expects). Rebinds reuse an id
			// the client already knows and publish immediately.
			setTimeout(() => {
				if (this.sessions.get(handle.sessionId) === handle) {
					this.emitAvailableCommands(handle);
				}
			}, 0);
		} else {
			this.emitAvailableCommands(handle);
		}
	}

	/**
	 * Publish the session's slash commands (extension commands, prompt
	 * templates, skills) after every bind and rebind — the command set belongs
	 * to the AgentSession, so a `/new` or fork can change it.
	 *
	 * Clients invoke these as `/name` prompt text, which `session.prompt()`
	 * already expands.
	 */
	private emitAvailableCommands(handle: AcpSessionHandle): void {
		const session = handle.runtime.session;
		const availableCommands: AvailableCommand[] = [];
		for (const command of session.extensionRunner.getRegisteredCommands()) {
			availableCommands.push({ name: command.invocationName, description: command.description ?? "" });
		}
		for (const template of session.promptTemplates) {
			availableCommands.push({
				name: template.name,
				description: template.description,
				...(template.argumentHint ? { input: { hint: template.argumentHint } } : {}),
			});
		}
		for (const skill of session.resourceLoader.getSkills().skills) {
			availableCommands.push({ name: `skill:${skill.name}`, description: skill.description });
		}
		handle.translator.sendUpdate({ sessionUpdate: "available_commands_update", availableCommands });
	}

	/** Dispose all sessions (used on shutdown and by the test harness). */
	async dispose(): Promise<void> {
		const handles = [...this.sessions.values()];
		this.sessions.clear();
		for (const handle of handles) {
			handle.unsubscribe?.();
			handle.unsubscribeBackpressure?.();
			handle.toolCalls.dispose();
			try {
				await handle.runtime.dispose();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`ACP: failed to dispose session ${handle.sessionId}: ${message}`);
			}
		}
	}
}
