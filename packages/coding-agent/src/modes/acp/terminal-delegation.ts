/**
 * Terminal delegation: a `BashOperations` implementation over ACP
 * `terminal/*` methods.
 *
 * Gated on `clientCapabilities.terminal`: without the capability, execution
 * falls back to pi's local shell backend (`createLocalBashOperations`).
 *
 * `terminal/create` is invoked in argv form (`sh -c <command>`) rather than
 * shipping a shell-specific invocation, so quoting/escaping is decided once.
 * Only the PI_* / spawn-hook env deltas relative to the agent process's own
 * environment are forwarded — the client's terminal already owns a baseline
 * environment (PATH, HOME, ...), and forwarding the entire process
 * environment would silently clobber it.
 *
 * `TerminalHandle.currentOutput()` is cumulative: every poll returns the
 * full output captured so far, not a delta since the last poll. This module
 * tracks how many bytes have already been forwarded to `onData` and emits
 * only the new suffix on each poll — emitting the whole buffer every time
 * would duplicate output at the tool layer.
 *
 * Abort and timeout both call `kill()`, then rely on the *shared* bash tool
 * layer (`src/core/tools/bash.ts`) for user-facing error formatting: this
 * namespace throws the same sentinel errors `createLocalBashOperations` throws
 * (`Error("aborted")`, `Error("timeout:<seconds>")`), so "Command aborted" /
 * "Command timed out after N seconds" come out identical to the local
 * backend. `release()` is always called in a `finally`, on every path
 * (success, nonzero exit, abort, timeout, or a thrown error) — a leaked
 * terminal handle is the worst failure mode here.
 */

import type { AgentSideConnection, EnvVariable } from "@agentclientprotocol/sdk";
import { type BashOperations, createLocalBashOperations } from "../../core/tools/bash.ts";
import type { AcpToolsOptionsContext, ClientCaps } from "./types.ts";

/** How often to poll the client terminal for new output. */
const POLL_INTERVAL_MS = 150;

/**
 * Env vars to forward to `terminal/create`: only keys whose value differs
 * from the agent process's own environment (PI_* session vars, spawnHook
 * edits, pi's local PATH additions) — never the full environment, which the
 * client's terminal already has its own copy of.
 */
function computeEnvDelta(env: NodeJS.ProcessEnv | undefined): EnvVariable[] {
	if (!env) return [];
	const delta: EnvVariable[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && value !== process.env[name]) {
			delta.push({ name, value });
		}
	}
	return delta;
}

/**
 * Create `BashOperations` that delegate execution to the client's terminal
 * over ACP `terminal/*`, falling back to pi's local shell backend when the
 * client hasn't advertised the `terminal` capability.
 */
export function createAcpBashOperations(
	connection: AgentSideConnection,
	sessionId: string,
	clientCaps: ClientCaps,
): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (!clientCaps.current?.terminal) {
				return local.exec(command, cwd, { onData, signal, timeout, env });
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const terminal = await connection.createTerminal({
				sessionId,
				command: "sh",
				args: ["-c", command],
				cwd,
				env: computeEnvDelta(env),
			});

			let emitted = 0;
			let done = false;
			let pollTimer: ReturnType<typeof setTimeout> | undefined;

			// currentOutput() is cumulative -- forward only the new suffix.
			const drain = async (): Promise<void> => {
				const { output } = await terminal.currentOutput();
				if (output.length > emitted) {
					onData(Buffer.from(output.slice(emitted)));
					emitted = output.length;
				}
			};

			const schedulePoll = () => {
				if (done) return;
				pollTimer = setTimeout(async () => {
					pollTimer = undefined;
					try {
						await drain();
					} catch {
						// The terminal may already be killed/released; the exit/abort
						// path below is authoritative, so swallow polling errors here.
					}
					schedulePoll();
				}, POLL_INTERVAL_MS);
			};
			schedulePoll();

			let timedOut = false;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				terminal.kill().catch(() => {});
			};

			try {
				if (timeout !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						terminal.kill().catch(() => {});
					}, timeout * 1000);
				}
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				const exit = await terminal.waitForExit();
				done = true;
				if (pollTimer) clearTimeout(pollTimer);
				try {
					await drain();
				} catch {
					// Best-effort final drain; the exit status above is authoritative.
				}

				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode: exit.exitCode ?? null };
			} finally {
				done = true;
				if (pollTimer) clearTimeout(pollTimer);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				// Release must never mask the outcome: a rejecting release inside a
				// finally block would replace the "aborted"/"timeout:N" sentinel the
				// bash tool layer formats, turning "Command aborted" into an
				// unrelated transport error.
				await terminal.release().catch(() => {});
			}
		},
	};
}

/**
 * `createToolsOptions` contribution wiring terminal delegation into the ACP
 * seam (`AcpToolsOptionsContext` from types.ts). Compose with fs
 * delegation's equivalent when building the `AcpAgentDeps.createToolsOptions`
 * callback main.ts passes to `runAcpMode`.
 */
export function acpTerminalToolsOptions(context: AcpToolsOptionsContext): { bash: { operations: BashOperations } } {
	return {
		bash: { operations: createAcpBashOperations(context.connection, context.sessionId, context.clientCaps) },
	};
}
