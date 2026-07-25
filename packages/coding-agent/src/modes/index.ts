/**
 * Run modes for the coding agent.
 */

export { PiAcpAgent } from "./acp/acp-agent.ts";
export { runAcpMode, type StartAcpAgentResult, startAcpAgent } from "./acp/acp-mode.ts";
export {
	AcpEventTranslator,
	type AcpToolEventSink,
	PromptTurnTracker,
} from "./acp/event-translator.ts";
export { AcpSessionRegistry } from "./acp/session-registry.ts";
export type {
	AcpAgentDeps,
	AcpModeOptions,
	AcpSessionHandle,
	AcpToolsOptionsContext,
	ClientCaps,
} from "./acp/types.ts";
export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
