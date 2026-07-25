/**
 * Reusable in-process test harness for ACP mode.
 *
 * Wires a real SDK `ClientSideConnection` to `startAcpAgent` over two crossed
 * in-memory `TransformStream`s — no child process, no stdio, no real model:
 *
 *   client (ClientSideConnection) --- clientToAgent ---> agent (startAcpAgent)
 *   client (ClientSideConnection) <--- agentToClient --- agent (startAcpAgent)
 *
 * The model side is a faux provider (`registerFauxProvider`) registered inside
 * a real runtime factory (same shape as `test/suite/agent-session-runtime.test.ts`),
 * so prompts run the full AgentSession pipeline against scripted responses.
 * The factory mirrors main.ts's E4 wiring, including `toolsOptions` forwarding
 * into `createAgentSessionFromServices`.
 *
 * Extension points for later milestones:
 * - `client`: override or add SDK `Client` handlers. fs handlers
 *   (`readTextFile`/`writeTextFile`) for M3, terminal handlers for M4,
 *   `requestPermission` for M6. `sessionUpdate` is always recorded by the
 *   harness first, then forwarded to any override.
 * - `clientCapabilities`: capabilities sent by `initialize()`. fs/terminal are
 *   off by default (M1); M3/M4 switch them on per test.
 * - `createToolsOptions`: forwarded into `AcpAgentDeps` — the delegation seam
 *   the session registry threads into every per-session runtime (M3/M4
 *   supply fs/terminal-backed operations here in production code).
 * - `responses` / `faux`: script model output, including tool calls
 *   (`fauxToolCall`) and context-capturing response factories.
 *
 * Always `await harness.dispose()` in `afterEach`: faux provider registration
 * is process-global and the harness creates real temp directories.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Client,
	type ClientCapabilities,
	ClientSideConnection,
	type ContentBlock,
	type InitializeRequest,
	type InitializeResponse,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptResponse,
	type SessionNotification,
	type SessionUpdate,
	type Stream,
} from "@agentclientprotocol/sdk";
import {
	type FauxModelDefinition,
	type FauxProviderRegistration,
	type FauxResponseStep,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { type StartAcpAgentResult, startAcpAgent } from "../../src/modes/acp/acp-mode.ts";
import type { AcpAgentDeps } from "../../src/modes/acp/types.ts";

export interface AcpHarnessOptions {
	/** Faux model definitions. Default: one reasoning-capable "faux-1" model. */
	models?: FauxModelDefinition[];
	/** Throttle faux streaming (tokens/second) so tests can act mid-stream. */
	tokensPerSecond?: number;
	/** Initially queued faux responses (same as `harness.faux.setResponses`). */
	responses?: FauxResponseStep[];
	/** Client capabilities sent by `initialize()`. Default: none (fs/terminal off). */
	clientCapabilities?: ClientCapabilities;
	/** Overrides for the client-side SDK handlers (fs/terminal/permission scripting). */
	client?: Partial<Client>;
	/** Delegation seam forwarded to `AcpAgentDeps.createToolsOptions`. */
	createToolsOptions?: AcpAgentDeps["createToolsOptions"];
}

export interface AcpNotificationWaitOptions {
	/** Reject after this many milliseconds. Default: 10 seconds. */
	timeoutMs?: number;
	/** Only consider notifications recorded at an index >= `after`. */
	after?: number;
}

export interface AcpHarness {
	/** Client-side view of the connection (initialize/newSession/prompt/cancel/...). */
	client: ClientSideConnection;
	/** Agent-side handle: SDK connection, PiAcpAgent instance, and dispose. */
	agent: StartAcpAgentResult;
	/** Faux provider registration for scripting model responses. */
	faux: FauxProviderRegistration;
	/** Temp working directory sent with session/new. */
	cwd: string;
	/** Temp session storage directory — session/new files land here. */
	sessionDir: string;
	/** Temp agent config directory. */
	agentDir: string;
	/** All session/update notifications in arrival order. */
	notifications: SessionNotification[];
	/** Send initialize. Overrides are merged over the harness defaults. */
	initialize(overrides?: Partial<InitializeRequest>): Promise<InitializeResponse>;
	/** Send session/new (does not initialize implicitly). */
	newSession(overrides?: { cwd?: string }): Promise<NewSessionResponse>;
	/** initialize (if not yet done) + session/new; returns the new session id. */
	openSession(): Promise<string>;
	/** Send session/prompt with plain text or explicit content blocks. */
	prompt(sessionId: string, content: string | ContentBlock[]): Promise<PromptResponse>;
	/** Send the session/cancel notification. */
	cancel(sessionId: string): Promise<void>;
	/** Resolve with the first recorded (or next incoming) notification matching `predicate`. */
	waitForNotification(
		predicate: (notification: SessionNotification) => boolean,
		options?: AcpNotificationWaitOptions,
	): Promise<SessionNotification>;
	/** All recorded updates of one sessionUpdate discriminant. */
	updatesOfType<T extends SessionUpdate["sessionUpdate"]>(
		type: T,
	): Array<Extract<SessionUpdate, { sessionUpdate: T }>>;
	/** Concatenated text of all recorded chunks of the given chunk type. */
	chunkText(type: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"): string;
	/** Tear down sessions, unregister the faux provider, and remove temp dirs. */
	dispose(): Promise<void>;
}

interface NotificationWaiter {
	predicate: (notification: SessionNotification) => boolean;
	resolve: (notification: SessionNotification) => void;
}

export async function createAcpHarness(options: AcpHarnessOptions = {}): Promise<AcpHarness> {
	const root = join(tmpdir(), `pi-acp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "cwd");
	const sessionDir = join(root, "sessions");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const faux = registerFauxProvider({
		models: options.models ?? [{ id: "faux-1", reasoning: true }],
		tokensPerSecond: options.tokensPerSecond,
	});
	if (options.responses) {
		faux.setResponses(options.responses);
	}

	// Mirrors the createRuntime closure main.ts builds (E4), including the
	// toolsOptions forwarding that the ACP session registry relies on.
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		sessionManager,
		sessionStartEvent,
		toolsOptions,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
				toolsOptions,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	// Two crossed TransformStreams: what the agent writes, the client reads,
	// and vice versa. The SDK Stream carries parsed JSON-RPC messages, so no
	// ndjson framing is needed in-process.
	const clientToAgent = new TransformStream();
	const agentToClient = new TransformStream();
	const agentStream: Stream = { writable: agentToClient.writable, readable: clientToAgent.readable };
	const clientStream: Stream = { writable: clientToAgent.writable, readable: agentToClient.readable };

	const agent = startAcpAgent(agentStream, {
		createRuntime,
		agentDir,
		sessionDir,
		createToolsOptions: options.createToolsOptions,
	});

	const notifications: SessionNotification[] = [];
	const waiters: NotificationWaiter[] = [];
	const record = (notification: SessionNotification): void => {
		notifications.push(notification);
		for (let index = waiters.length - 1; index >= 0; index--) {
			if (waiters[index].predicate(notification)) {
				const [waiter] = waiters.splice(index, 1);
				waiter.resolve(notification);
			}
		}
	};

	const overrides = options.client ?? {};
	const clientImpl: Client = {
		requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		...overrides,
		sessionUpdate: async (notification) => {
			record(notification);
			await overrides.sessionUpdate?.(notification);
		},
	};
	const client = new ClientSideConnection(() => clientImpl, clientStream);

	let initialized = false;
	const initialize = async (initializeOverrides?: Partial<InitializeRequest>): Promise<InitializeResponse> => {
		initialized = true;
		return client.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: options.clientCapabilities ?? {},
			...initializeOverrides,
		});
	};

	const newSession = async (sessionOverrides?: { cwd?: string }): Promise<NewSessionResponse> => {
		return client.newSession({ cwd: sessionOverrides?.cwd ?? cwd, mcpServers: [] });
	};

	const openSession = async (): Promise<string> => {
		if (!initialized) {
			await initialize();
		}
		const response = await newSession();
		return response.sessionId;
	};

	const prompt = (sessionId: string, content: string | ContentBlock[]): Promise<PromptResponse> => {
		return client.prompt({
			sessionId,
			prompt: typeof content === "string" ? [{ type: "text", text: content }] : content,
		});
	};

	const cancel = (sessionId: string): Promise<void> => {
		return client.cancel({ sessionId });
	};

	const waitForNotification = (
		predicate: (notification: SessionNotification) => boolean,
		waitOptions: AcpNotificationWaitOptions = {},
	): Promise<SessionNotification> => {
		const { timeoutMs = 10_000, after = 0 } = waitOptions;
		const existing = notifications.slice(after).find(predicate);
		if (existing) {
			return Promise.resolve(existing);
		}
		return new Promise((resolve, reject) => {
			const waiter: NotificationWaiter = {
				predicate,
				resolve: (notification) => {
					clearTimeout(timer);
					resolve(notification);
				},
			};
			const timer = setTimeout(() => {
				const index = waiters.indexOf(waiter);
				if (index !== -1) {
					waiters.splice(index, 1);
				}
				reject(new Error(`Timed out waiting for a session/update notification after ${timeoutMs}ms`));
			}, timeoutMs);
			waiters.push(waiter);
		});
	};

	const updatesOfType = <T extends SessionUpdate["sessionUpdate"]>(
		type: T,
	): Array<Extract<SessionUpdate, { sessionUpdate: T }>> => {
		return notifications
			.map((notification) => notification.update)
			.filter((update): update is Extract<SessionUpdate, { sessionUpdate: T }> => update.sessionUpdate === type);
	};

	const chunkText = (type: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"): string => {
		return updatesOfType(type)
			.map((update) => (update.content.type === "text" ? update.content.text : ""))
			.join("");
	};

	const dispose = async (): Promise<void> => {
		await agent.dispose();
		faux.unregister();
		if (existsSync(root)) {
			rmSync(root, { recursive: true, force: true });
		}
	};

	return {
		client,
		agent,
		faux,
		cwd,
		sessionDir,
		agentDir,
		notifications,
		initialize,
		newSession,
		openSession,
		prompt,
		cancel,
		waitForNotification,
		updatesOfType,
		chunkText,
		dispose,
	};
}
