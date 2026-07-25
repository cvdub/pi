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
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { resolvePath } from "../../utils/paths.ts";
import { AcpEventTranslator, PromptTurnTracker } from "./event-translator.ts";
import type { AcpAgentDeps, AcpSessionHandle, ClientCaps } from "./types.ts";

export class AcpSessionRegistry {
	private readonly connection: AgentSideConnection;
	private readonly deps: AcpAgentDeps;
	private readonly clientCaps: ClientCaps;
	private readonly sessions = new Map<string, AcpSessionHandle>();

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

		const tracker = new PromptTurnTracker();
		const translator = new AcpEventTranslator({
			sessionId,
			sendNotification: (notification) => this.connection.sessionUpdate(notification),
			tracker,
			// `runtime.session` always points at the current session, also after
			// extension-driven replacement.
			isSessionIdle: () => runtime.session.isIdle,
			// TODO(M2): pass the tool-call-mapper here as `toolEventSink`.
		});

		const handle: AcpSessionHandle = { sessionId, runtime, translator, prompts: tracker };
		// Mandatory rebind: after /new, fork, or /resume replaces the session,
		// re-bind extensions and re-subscribe — otherwise updates silently stop.
		runtime.setRebindSession(async () => {
			await this.bindHandle(handle);
		});
		await this.bindHandle(handle);
		this.sessions.set(sessionId, handle);
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

	private async bindHandle(handle: AcpSessionHandle): Promise<void> {
		const session = handle.runtime.session;
		await session.bindExtensions({
			mode: "acp",
			// TODO(M6): supply an ACP-backed uiContext (extension-ui.ts) so
			// confirm/select round-trip through session/request_permission.
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
		// TODO(M2): emit available_commands_update after every bind/rebind.
	}

	/** Dispose all sessions (used on shutdown and by the test harness). */
	async dispose(): Promise<void> {
		const handles = [...this.sessions.values()];
		this.sessions.clear();
		for (const handle of handles) {
			handle.unsubscribe?.();
			handle.unsubscribeBackpressure?.();
			try {
				await handle.runtime.dispose();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`ACP: failed to dispose session ${handle.sessionId}: ${message}`);
			}
		}
	}
}
