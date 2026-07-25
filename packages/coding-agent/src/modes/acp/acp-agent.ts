/**
 * PiAcpAgent: pi's implementation of the ACP SDK `Agent` interface.
 *
 * One instance per connection. Sessions are owned by the AcpSessionRegistry;
 * the ACP sessionId is the pi session UUID. `session/new`'s `mcpServers`
 * param is accepted and ignored (pi has no MCP support), and accordingly no
 * `mcpCapabilities` are advertised.
 */

import type {
	Agent,
	AgentSideConnection,
	AuthenticateRequest,
	AuthenticateResponse,
	CancelNotification,
	ClientCapabilities,
	InitializeRequest,
	InitializeResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { promptBlocksToPi } from "./content.ts";
import { AcpSessionRegistry } from "./session-registry.ts";
import type { AcpAgentDeps, ClientCaps } from "./types.ts";

export class PiAcpAgent implements Agent {
	private readonly registry: AcpSessionRegistry;
	private readonly clientCaps: ClientCaps = { current: undefined };

	constructor(connection: AgentSideConnection, deps: AcpAgentDeps) {
		this.registry = new AcpSessionRegistry(connection, deps, this.clientCaps);
	}

	/** Capabilities stashed from the client's initialize request. */
	get clientCapabilities(): ClientCapabilities | undefined {
		return this.clientCaps.current;
	}

	/** Session registry (exposed for shutdown and tests). */
	get sessions(): AcpSessionRegistry {
		return this.registry;
	}

	initialize(params: InitializeRequest): InitializeResponse {
		this.clientCaps.current = params.clientCapabilities;
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
			},
			authMethods: [],
		};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		// params.mcpServers is intentionally ignored (no MCP support in pi).
		const handle = await this.registry.createSession({ cwd: params.cwd });
		return { sessionId: handle.sessionId };
	}

	// loadSession arrives in M5 (history-replay.ts). Until then the SDK
	// responds with method-not-found for session/load.

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const handle = this.registry.require(params.sessionId);
		const session = handle.runtime.session;
		const { text, images } = promptBlocksToPi(params.prompt);

		const turn = handle.prompts.register();
		let preflightSucceeded = false;
		// The prompt request resolves on the session's next settle (never on
		// agent_end: willRetry turns would return early). A prompt sent
		// mid-turn steers the active turn; every pending request resolves
		// together at that settle.
		void session
			.prompt(text, {
				images: images.length > 0 ? images : undefined,
				source: "rpc",
				streamingBehavior: session.isStreaming ? "steer" : undefined,
				preflightResult: (didSucceed) => {
					if (didSucceed) {
						preflightSucceeded = true;
					}
				},
			})
			.then(
				() => {
					// Prompts handled without an agent run (extension commands)
					// never emit agent_settled; resolve them once deliveries
					// flush if the session is idle.
					handle.translator.settleIfIdle();
				},
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					if (preflightSucceeded) {
						console.error(`ACP: prompt failed after preflight: ${message}`);
						handle.translator.settleIfIdle();
					} else {
						turn.fail(RequestError.internalError({ sessionId: params.sessionId }, message));
					}
				},
			);

		return { stopReason: await turn.promise };
	}

	async cancel(params: CancelNotification): Promise<void> {
		const handle = this.registry.get(params.sessionId);
		if (!handle) {
			return;
		}
		// Pre-mark the tracker so the settle after abort resolves the pending
		// prompt(s) with stopReason "cancelled" — after final updates flush.
		if (handle.prompts.hasPending) {
			handle.prompts.markCancelled();
		}
		await handle.runtime.session.abort();
	}

	authenticate(_params: AuthenticateRequest): AuthenticateResponse {
		// No auth methods are advertised; nothing to do.
		return {};
	}
}
