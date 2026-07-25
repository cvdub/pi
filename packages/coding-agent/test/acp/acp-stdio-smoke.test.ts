/**
 * End-to-end acceptance gate for ACP mode (M7): a real child process, a raw
 * ndjson `initialize` request on stdin, and a hard assertion that stdout
 * carries nothing but JSON-RPC frames.
 *
 * Every other ACP test in this directory drives `startAcpAgent` in-process
 * over crossed in-memory streams (see acp-harness.ts) — useful for exercising
 * protocol logic, but it can never catch a stray `console.log`, an extension
 * writing to the real `process.stdout`, or any other leak that would corrupt
 * the wire for a real client. This test spawns `node dist/cli.js --mode acp`
 * exactly the way an ACP client (e.g. Emacs agent-shell) would, and checks
 * the one property that matters most: zero non-protocol bytes on stdout.
 *
 * Requires a build: it exercises the compiled `dist/cli.js`, not the
 * TypeScript source, so `npm run build` must have run first. The guard below
 * fails with a clear message instead of a raw ENOENT if it hasn't.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";

const distCliPath = resolve(__dirname, "../../dist/cli.js");

const tempDirs: string[] = [];

beforeAll(() => {
	if (!existsSync(distCliPath)) {
		throw new Error(
			`ACP stdio smoke test requires a build: ${distCliPath} does not exist.\n` +
				"Run `npm run build` from the repo root (or `packages/coding-agent`) before running this test.",
		);
	}
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

interface AcpSmokeResult {
	/** Raw stdout exactly as written by the child process. */
	stdout: string;
	/** Every complete (`\n`-terminated) stdout line, JSON-parsed. */
	stdoutMessages: unknown[];
	stderr: string;
	code: number | null;
}

/**
 * Spawn the built ACP CLI, write one raw ndjson request to stdin, close
 * stdin (the client-disconnect signal `runAcpMode` shuts down on), and
 * collect everything the child wrote before it exits.
 */
async function runAcpSmoke(request: Record<string, unknown>): Promise<AcpSmokeResult> {
	const cwd = createTempDir("pi-acp-smoke-cwd-");
	const agentDir = createTempDir("pi-acp-smoke-agent-");

	const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [distCliPath, "--mode", "acp"], {
		cwd,
		env: {
			...process.env,
			[ENV_AGENT_DIR]: agentDir,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const exited = new Promise<number | null>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", (code) => resolvePromise(code));
	});

	child.stdin.write(`${JSON.stringify(request)}\n`);
	child.stdin.end();

	const timeoutMs = 15_000;
	const code = await Promise.race([
		exited,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`pi --mode acp did not exit within ${timeoutMs}ms of stdin closing`));
			}, timeoutMs);
		}),
	]);

	// Every complete line must be valid JSON — the whole point of this test.
	// Split (not filter-then-parse) so a bad line fails with the offending
	// text attached, instead of a generic JSON.parse error.
	const lines = stdout.split("\n").filter((line) => line.length > 0);
	const stdoutMessages = lines.map((line) => {
		try {
			return JSON.parse(line);
		} catch (_error) {
			throw new Error(`stdout contained a non-JSON-RPC line (protocol corruption): ${JSON.stringify(line)}`);
		}
	});

	return { stdout, stdoutMessages, stderr, code };
}

describe("ACP stdio smoke test (M7 acceptance gate)", () => {
	it("returns a valid initialize response with zero non-protocol bytes on stdout", async () => {
		const result = await runAcpSmoke({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1 },
		});

		expect(result.code).toBe(0);

		// Zero non-protocol bytes: every line on stdout is a JSON-RPC 2.0
		// message. (Already enforced by runAcpSmoke's parse step above; assert
		// it explicitly here too so a future refactor of the helper can't
		// silently weaken the guarantee.)
		expect(result.stdoutMessages.length).toBeGreaterThan(0);
		for (const message of result.stdoutMessages) {
			expect(message).toMatchObject({ jsonrpc: "2.0" });
		}

		const response = result.stdoutMessages.find(
			(message): message is { jsonrpc: string; id: number; result?: unknown; error?: unknown } =>
				typeof message === "object" && message !== null && "id" in message && (message as { id: unknown }).id === 1,
		);
		expect(response).toBeDefined();
		expect(response?.error).toBeUndefined();
		expect(response?.result).toMatchObject({
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
			},
			authMethods: [],
		});
		// MCP passthrough is out of scope: no mcpCapabilities should be advertised.
		expect(
			(response?.result as { agentCapabilities?: { mcpCapabilities?: unknown } })?.agentCapabilities,
		).not.toHaveProperty("mcpCapabilities");
	});

	it("never writes non-JSON bytes to stdout even when stdin sends malformed JSON-RPC first", async () => {
		// A garbage line ahead of a real request is the harshest stress case for
		// stdout purity: any startup diagnostic, warning, or parse-error report
		// that leaks onto stdout instead of stderr would show up here as a
		// non-JSON line.
		const cwd = createTempDir("pi-acp-smoke-cwd-");
		const agentDir = createTempDir("pi-acp-smoke-agent-");
		const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [distCliPath, "--mode", "acp"], {
			cwd,
			env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.resume();

		const exited = new Promise<number | null>((resolvePromise) => {
			child.on("close", (code) => resolvePromise(code));
		});

		child.stdin.write("not json at all\n");
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: 1 } })}\n`,
		);
		child.stdin.end();

		const timeoutMs = 15_000;
		await Promise.race([
			exited,
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`pi --mode acp did not exit within ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);

		const lines = stdout.split("\n").filter((line) => line.length > 0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});
