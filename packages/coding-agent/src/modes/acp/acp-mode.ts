/**
 * ACP mode: native Agent Client Protocol support over stdio.
 *
 * `runAcpMode` wires process stdio into an SDK ndjson Stream and hands it to
 * `startAcpAgent`, which is exported separately so tests can drive the agent
 * with in-memory streams.
 *
 * Stdout purity: takeOverStdout() already redirects stray process.stdout
 * writes to stderr; the outbound protocol stream is built exclusively on
 * writeRawStdout + waitForRawStdoutBackpressure. restoreStdout() is never
 * called — the guard keeps extension console.log off the wire for the whole
 * process lifetime.
 */

import { Readable } from "node:stream";
import type { Stream } from "@agentclientprotocol/sdk";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type { ToolsOptions } from "../../core/tools/index.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { PiAcpAgent } from "./acp-agent.ts";
import { createAcpFsToolsOptions } from "./fs-delegation.ts";
import { acpTerminalToolsOptions } from "./terminal-delegation.ts";
import type { AcpAgentDeps, AcpModeOptions, AcpToolsOptionsContext } from "./types.ts";

export interface StartAcpAgentResult {
	/** The SDK connection (client-bound requests/notifications). */
	connection: AgentSideConnection;
	/** The agent servicing this connection. */
	agent: PiAcpAgent;
	/** Dispose every session created on this connection. */
	dispose(): Promise<void>;
}

/**
 * Attach a PiAcpAgent to an SDK Stream.
 *
 * Transport-agnostic: `runAcpMode` passes the stdio ndjson stream, tests pass
 * crossed in-memory TransformStreams.
 */
export function startAcpAgent(stream: Stream, deps: AcpAgentDeps): StartAcpAgentResult {
	let agent: PiAcpAgent | undefined;
	const connection = new AgentSideConnection((conn) => {
		agent = new PiAcpAgent(conn, deps);
		return agent;
	}, stream);
	if (!agent) {
		throw new Error("AgentSideConnection did not construct the agent synchronously");
	}
	const startedAgent = agent;
	return {
		connection,
		agent: startedAgent,
		dispose: () => startedAgent.sessions.dispose(),
	};
}

/**
 * Default delegation for real ACP sessions: fs (M3) plus terminal (M4).
 *
 * Each half contributes a disjoint slice of ToolsOptions — fs owns
 * `read`/`edit`/`write`, terminal owns `bash` — so a shallow merge composes
 * them without either clobbering the other. Both halves gate themselves on the
 * matching `clientCapabilities` entry and fall back to local operations when it
 * is absent, so this is safe to install unconditionally.
 */
export function createAcpToolsOptions(context: AcpToolsOptionsContext): ToolsOptions {
	return { ...createAcpFsToolsOptions(context), ...acpTerminalToolsOptions(context) };
}

/**
 * Run in ACP mode over stdio.
 *
 * The bootstrap runtime main.ts built is disposed immediately: ACP creates a
 * fresh runtime per session/new bound to the client's cwd (via the wrapped
 * factory in the session registry).
 */
export async function runAcpMode(runtimeHost: AgentSessionRuntime, options: AcpModeOptions): Promise<never> {
	takeOverStdout();
	await runtimeHost.dispose();

	const decoder = new TextDecoder();
	const outbound = new WritableStream<Uint8Array>({
		write: (chunk) => {
			writeRawStdout(decoder.decode(chunk, { stream: true }));
			return waitForRawStdoutBackpressure();
		},
	});
	const inbound = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const stream = ndJsonStream(outbound, inbound);

	let shuttingDown = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const { connection, dispose } = startAcpAgent(stream, {
		...options,
		// Real ACP sessions (main.ts's runAcpMode call) don't supply
		// createToolsOptions, so default to the combined fs (M3) + terminal (M4)
		// delegation here. Both halves are capability-gated with local
		// fallbacks. Callers that inject their own (e.g. tests) are untouched.
		createToolsOptions: options.createToolsOptions ?? createAcpToolsOptions,
		onShutdownRequested: () => {
			options.onShutdownRequested?.();
			void shutdown(0);
		},
	});

	async function shutdown(exitCode: number, signal?: NodeJS.Signals): Promise<never> {
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await dispose();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	const signals: NodeJS.Signals[] = ["SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	for (const signal of signals) {
		const handler = () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	// The connection closes when stdin ends (client disconnected).
	await connection.closed;
	return shutdown(0);
}
