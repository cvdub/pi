/**
 * M4 acceptance tests for ACP mode: terminal delegation.
 *
 * `createAcpBashOperations` is driven directly (unit style) for the
 * delta/abort/timeout/release assertions -- `TerminalHandle` has a private
 * constructor, so the only way to get a real one is through a real
 * `AgentSideConnection.createTerminal()` call, which is why these tests still
 * go through the harness's crossed-stream connection with a scripted
 * `client` override rather than hand-rolling a fake TerminalHandle.
 *
 * One end-to-end test drives the same wiring through
 * `AcpAgentDeps.createToolsOptions` and a real `fauxToolCall("bash", ...)`
 * prompt turn, so the seam itself is covered too.
 */

import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool } from "../../src/core/tools/bash.ts";
import { acpTerminalToolsOptions, createAcpBashOperations } from "../../src/modes/acp/terminal-delegation.ts";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

describe("ACP terminal delegation (M4)", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("emits onData deltas from cumulative currentOutput, never the whole buffer twice", async () => {
		let outputCalls = 0;
		const createTerminalCalls: CreateTerminalRequest[] = [];
		const killCalls: string[] = [];
		const releaseCalls: string[] = [];
		harness = await createAcpHarness({
			clientCapabilities: { terminal: true },
			client: {
				createTerminal: async (params) => {
					createTerminalCalls.push(params);
					return { terminalId: "term-delta" };
				},
				// Cumulative output: "a" on the first poll, "ab" from then on.
				// A buggy caller that forwards the whole buffer each time would
				// produce onData("a"), onData("ab") -- the duplicated-concatenation
				// regression this milestone exists to prevent.
				terminalOutput: async () => {
					outputCalls += 1;
					return outputCalls === 1 ? { output: "a", truncated: false } : { output: "ab", truncated: false };
				},
				waitForTerminalExit: async () => {
					// Only resolve once the poller has observed both output stages,
					// so the test doesn't race the 150ms poll interval.
					while (outputCalls < 2) {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					return { exitCode: 0 };
				},
				killTerminal: async ({ terminalId }) => {
					killCalls.push(terminalId);
					return {};
				},
				releaseTerminal: async ({ terminalId }) => {
					releaseCalls.push(terminalId);
					return {};
				},
			},
		});
		const sessionId = await harness.openSession();
		const ops = createAcpBashOperations(harness.agent.connection, sessionId, { current: { terminal: true } });

		const chunks: string[] = [];
		const result = await ops.exec("echo delta", harness.cwd, {
			onData: (data) => chunks.push(data.toString("utf8")),
		});

		expect(result.exitCode).toBe(0);
		expect(chunks).toEqual(["a", "b"]);
		expect(createTerminalCalls).toHaveLength(1);
		expect(createTerminalCalls[0]).toMatchObject({ sessionId, command: "sh", args: ["-c", "echo delta"] });
		expect(killCalls).toEqual([]);
		expect(releaseCalls).toEqual(["term-delta"]);
	});

	it("nonzero exit surfaces as an error result at the tool layer", async () => {
		harness = await createAcpHarness({
			clientCapabilities: { terminal: true },
			client: {
				createTerminal: async () => ({ terminalId: "term-nonzero" }),
				terminalOutput: async () => ({ output: "boom\n", truncated: false }),
				waitForTerminalExit: async () => ({ exitCode: 2 }),
				killTerminal: async () => ({}),
				releaseTerminal: async () => ({}),
			},
		});
		const sessionId = await harness.openSession();
		const ops = createAcpBashOperations(harness.agent.connection, sessionId, { current: { terminal: true } });
		const tool = createBashTool(harness.cwd, { operations: ops });

		await expect(tool.execute("call-1", { command: "exit 2" })).rejects.toThrow("Command exited with code 2");
	});

	it("abort kills the terminal, releases it, and surfaces pi's Command aborted format", async () => {
		let killCalled = false;
		let releaseCalled = false;
		let resolveExit: ((value: { exitCode: number | null }) => void) | undefined;
		const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
			resolveExit = resolve;
		});
		const controller = new AbortController();
		harness = await createAcpHarness({
			clientCapabilities: { terminal: true },
			client: {
				createTerminal: async () => {
					// Abort inside the client's own response to createTerminal:
					// deterministically, by the time the agent side's
					// `await connection.createTerminal(...)` resolves, the signal
					// is already aborted, so the abort-after-creation path (kill a
					// real terminal) is exercised without any timing race.
					controller.abort();
					return { terminalId: "term-abort" };
				},
				terminalOutput: async () => ({ output: "still running\n", truncated: false }),
				waitForTerminalExit: async () => exitPromise,
				killTerminal: async () => {
					killCalled = true;
					resolveExit?.({ exitCode: null });
					return {};
				},
				releaseTerminal: async () => {
					releaseCalled = true;
					return {};
				},
			},
		});
		const sessionId = await harness.openSession();
		const ops = createAcpBashOperations(harness.agent.connection, sessionId, { current: { terminal: true } });
		const tool = createBashTool(harness.cwd, { operations: ops });

		await expect(tool.execute("call-1", { command: "sleep 30" }, controller.signal)).rejects.toThrow(
			"Command aborted",
		);
		expect(killCalled).toBe(true);
		expect(releaseCalled).toBe(true);
	});

	it("timeout kills the terminal, releases it, and surfaces pi's Command timed out format", async () => {
		let killCalled = false;
		let releaseCalled = false;
		let resolveExit: ((value: { exitCode: number | null }) => void) | undefined;
		const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
			resolveExit = resolve;
		});
		harness = await createAcpHarness({
			clientCapabilities: { terminal: true },
			client: {
				createTerminal: async () => ({ terminalId: "term-timeout" }),
				terminalOutput: async () => ({ output: "still running\n", truncated: false }),
				waitForTerminalExit: async () => exitPromise,
				killTerminal: async () => {
					killCalled = true;
					resolveExit?.({ exitCode: null });
					return {};
				},
				releaseTerminal: async () => {
					releaseCalled = true;
					return {};
				},
			},
		});
		const sessionId = await harness.openSession();
		const ops = createAcpBashOperations(harness.agent.connection, sessionId, { current: { terminal: true } });
		const tool = createBashTool(harness.cwd, { operations: ops });

		await expect(tool.execute("call-1", { command: "sleep 30", timeout: 0.01 })).rejects.toThrow(
			"Command timed out after 0.01 seconds",
		);
		expect(killCalled).toBe(true);
		expect(releaseCalled).toBe(true);
	});

	it("falls back to the local shell backend when the client has no terminal capability", async () => {
		harness = await createAcpHarness();
		const sessionId = await harness.openSession();
		const ops = createAcpBashOperations(harness.agent.connection, sessionId, { current: undefined });

		const chunks: Buffer[] = [];
		const result = await ops.exec("echo hi", harness.cwd, { onData: (data) => chunks.push(data) });

		expect(result.exitCode).toBe(0);
		expect(Buffer.concat(chunks).toString("utf8")).toContain("hi");
	});

	it("wires terminal delegation through createToolsOptions end-to-end for a bash tool call", async () => {
		const createTerminalCalls: CreateTerminalRequest[] = [];
		harness = await createAcpHarness({
			clientCapabilities: { terminal: true },
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello-acp-terminal" }, { id: "call-bash" })]),
				fauxAssistantMessage("ran it"),
			],
			createToolsOptions: (context) => acpTerminalToolsOptions(context),
			client: {
				createTerminal: async (params) => {
					createTerminalCalls.push(params);
					return { terminalId: "term-e2e" };
				},
				terminalOutput: async () => ({ output: "hello-acp-terminal\n", truncated: false }),
				waitForTerminalExit: async () => ({ exitCode: 0 }),
				killTerminal: async () => ({}),
				releaseTerminal: async () => ({}),
			},
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "run echo via terminal delegation");

		expect(response.stopReason).toBe("end_turn");
		expect(createTerminalCalls).toHaveLength(1);
		expect(createTerminalCalls[0]).toMatchObject({ command: "sh", args: ["-c", "echo hello-acp-terminal"] });
		const updates = harness.toolCallUpdates("call-bash");
		expect(updates[updates.length - 1]?.status).toBe("completed");
	});
});

describe("ACP terminal delegation: release failures (M4)", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("a rejecting release does not mask the abort sentinel", async () => {
		let resolveExit: ((value: { exitCode: number | null }) => void) | undefined;
		const exitPromise = new Promise<{ exitCode: number | null }>((resolve) => {
			resolveExit = resolve;
		});
		const controller = new AbortController();
		harness = await createAcpHarness({
			clientCapabilities: { terminal: true },
			client: {
				createTerminal: async () => {
					controller.abort();
					return { terminalId: "term-release-fail" };
				},
				terminalOutput: async () => ({ output: "", truncated: false }),
				waitForTerminalExit: async () => exitPromise,
				killTerminal: async () => {
					resolveExit?.({ exitCode: null });
					return {};
				},
				// A client that refuses to release must not turn "Command aborted"
				// into an unrelated transport error: release runs in a finally, so
				// a rejection there would replace the in-flight abort sentinel.
				releaseTerminal: async () => {
					throw new Error("client refused to release the terminal");
				},
			},
		});
		const sessionId = await harness.openSession();
		const ops = createAcpBashOperations(harness.agent.connection, sessionId, { current: { terminal: true } });
		const tool = createBashTool(harness.cwd, { operations: ops });

		await expect(tool.execute("call-1", { command: "sleep 30" }, controller.signal)).rejects.toThrow(
			"Command aborted",
		);
	});
});
