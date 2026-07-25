/**
 * Shared types for ACP (Agent Client Protocol) mode.
 *
 * ACP mode maps each ACP sessionId to exactly one pi session record: the ACP
 * sessionId IS the pi SessionManager UUID. Each session owns a full
 * AgentSessionRuntime plus an event translator and the pending prompt
 * trackers used to resolve `session/prompt` requests.
 */

import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import type { ToolsOptions } from "../../core/tools/index.ts";
import type { AcpEventTranslator, PromptTurnTracker } from "./event-translator.ts";
import type { AcpToolCallMapper } from "./tool-call-mapper.ts";

/**
 * Mutable holder for the capabilities the client sent in `initialize`.
 *
 * Shared by reference between the agent (which stashes them) and the session
 * registry/delegation layers (which gate behavior on them: fs delegation in
 * M3, terminal delegation in M4).
 */
export interface ClientCaps {
	current: ClientCapabilities | undefined;
}

/** Context handed to {@link AcpAgentDeps.createToolsOptions} for each runtime build. */
export interface AcpToolsOptionsContext {
	/** ACP session id (== pi session id) the runtime belongs to. */
	sessionId: string;
	/** Effective cwd of the runtime being created. */
	cwd: string;
	/** Agent-side connection for client-delegated operations (fs/*, terminal/*). */
	connection: AgentSideConnection;
	/** Capabilities stashed at initialize time (gate delegation on these). */
	clientCaps: ClientCaps;
}

/**
 * Dependencies for running an ACP agent.
 *
 * `runAcpMode` builds these from main.ts state; tests build them around a faux
 * provider runtime factory and in-memory streams.
 */
export interface AcpAgentDeps {
	/**
	 * Factory used to create the per-session runtimes (the same closure main.ts
	 * builds). The session registry wraps it to inject `toolsOptions`, so
	 * extension-driven session replacement (/new, fork) inherits delegation
	 * automatically.
	 */
	createRuntime: CreateAgentSessionRuntimeFactory;
	/** Global agent config directory. */
	agentDir: string;
	/** Session storage directory override. Default: pi's per-cwd default dir. */
	sessionDir?: string;
	/**
	 * Builds the ToolsOptions injected into every runtime created for an ACP
	 * session. M1 leaves this undefined; M3 (fs delegation) and M4 (terminal
	 * delegation) supply client-backed operations here.
	 */
	createToolsOptions?: (context: AcpToolsOptionsContext) => ToolsOptions | undefined;
	/** Invoked when an extension requests shutdown (pi.shutdown()). */
	onShutdownRequested?: () => void;
}

/** Options accepted by `runAcpMode` (currently identical to the agent deps). */
export type AcpModeOptions = AcpAgentDeps;

/**
 * Per-ACP-session state owned by the session registry.
 *
 * One handle per ACP sessionId. The runtime may replace its underlying
 * AgentSession over time (/new, fork, /resume) — the handle, translator, and
 * prompt tracker survive those replacements via the rebind hook.
 */
export interface AcpSessionHandle {
	/** ACP session id == pi SessionManager UUID. */
	readonly sessionId: string;
	/** The runtime hosting the current AgentSession for this ACP session. */
	readonly runtime: AgentSessionRuntime;
	/** Translates AgentSessionEvents into session/update notifications. */
	readonly translator: AcpEventTranslator;
	/** Translates pi tool events into tool_call/tool_call_update notifications. */
	readonly toolCalls: AcpToolCallMapper;
	/** Pending `session/prompt` requests awaiting the next settle. */
	readonly prompts: PromptTurnTracker;
	/** Unsubscribe from the current session's events (reset on rebind). */
	unsubscribe?: () => void;
	/** Unsubscribe the outbound backpressure hook (reset on rebind). */
	unsubscribeBackpressure?: () => void;
}
