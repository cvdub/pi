/**
 * M5 acceptance tests: `session/load` history replay and multi-session behavior.
 *
 * Two things are pinned here that nothing else pins:
 *
 * 1. **Ordering.** The full replayed history must be on the wire *before* the
 *    `session/load` response. Both observation points are asserted: the raw
 *    agent -> client message log (`harness.wire`, ground truth, independent of
 *    the client dispatcher) and the client-observed notification count captured
 *    in the first continuation after the request resolves.
 * 2. **Isolation.** Two concurrent sessions on one connection stream, settle,
 *    and cancel independently — each notification carries its own sessionId and
 *    a cancel never reaches the other session's in-flight turn.
 *
 * Reconnects are simulated by disposing a harness and building a second one
 * over the same directories (`AcpHarnessOptions.dirs`), which is exactly what a
 * client does when it restarts pi and resumes a session id.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AnyMessage, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import { type Context, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { type AcpHarness, type AcpHarnessDirs, type AcpHarnessOptions, createAcpHarness } from "./acp-harness.ts";

const USER_TEXT = "read the note please";
const THOUGHT_TEXT = "The note is small, reading it is cheap.";
const PREAMBLE_TEXT = "Let me read the note.";
const FINAL_TEXT = "The note says hello.";
const NOTE_CONTENTS = "SENTINEL-NOTE-BODY\n";
/** Long enough that a cancel lands mid-stream at the throttled token rates below. */
const ALPHA_TEXT = "alpha ".repeat(200);
const BETA_TEXT = "beta ".repeat(200);

describe("ACP session/load (M5)", () => {
	const harnesses: AcpHarness[] = [];
	const roots: string[] = [];

	afterEach(async () => {
		for (const harness of [...harnesses].reverse()) {
			await harness.dispose();
		}
		harnesses.length = 0;
		for (const root of roots) {
			if (existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		roots.length = 0;
	});

	/** A harness tracked for disposal in `afterEach`. */
	async function openHarness(options: AcpHarnessOptions): Promise<AcpHarness> {
		const harness = await createAcpHarness(options);
		harnesses.push(harness);
		return harness;
	}

	/** Dispose one harness early (simulating pi exiting) without double-disposing later. */
	async function closeHarness(harness: AcpHarness): Promise<void> {
		const index = harnesses.indexOf(harness);
		if (index !== -1) {
			harnesses.splice(index, 1);
		}
		await harness.dispose();
	}

	/**
	 * Directories shared between a first harness and the one that reconnects to
	 * it. Owned by the test, not by either harness.
	 */
	function sharedDirs(cwdName = "cwd"): AcpHarnessDirs {
		const root = join(tmpdir(), `pi-acp-load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const dirs = {
			cwd: join(root, cwdName),
			sessionDir: join(root, "sessions"),
			agentDir: join(root, "agent"),
		};
		mkdirSync(dirs.cwd, { recursive: true });
		return dirs;
	}

	/**
	 * Run one full turn (thought + text + a completed `read` tool call + a final
	 * message) through a first connection, then drop that connection.
	 *
	 * Returns the pi/ACP session id, which is all a reconnecting client keeps.
	 */
	async function seedSession(dirs: AcpHarnessDirs): Promise<string> {
		writeFileSync(join(dirs.cwd, "note.txt"), NOTE_CONTENTS);
		const first = await openHarness({
			dirs,
			responses: [
				fauxAssistantMessage([
					fauxThinking(THOUGHT_TEXT),
					fauxText(PREAMBLE_TEXT),
					fauxToolCall("read", { path: "note.txt" }),
				]),
				fauxAssistantMessage(FINAL_TEXT),
			],
		});
		const sessionId = await first.openSession();
		const response = await first.prompt(sessionId, USER_TEXT);
		expect(response.stopReason).toBe("end_turn");
		await closeHarness(first);
		return sessionId;
	}

	it("streams the complete history before the session/load response", async () => {
		const dirs = sharedDirs();
		const sessionId = await seedSession(dirs);

		const reconnected = await openHarness({ dirs });
		await reconnected.initialize();

		const wireMark = reconnected.wire.length;
		// Captured in the first continuation after the request resolves: if any
		// part of the history were still queued, this count would fall short.
		let notificationsAtResolve = -1;
		await reconnected.loadSession(sessionId).then((response) => {
			notificationsAtResolve = reconnected.notifications.length;
			return response;
		});

		// Settle first, so anything the agent wrote *after* the response has had
		// time to show up in both logs below and cannot hide from the ordering
		// assertions.
		await delay(250);

		// ORDERING, on the wire (ground truth, independent of how the client's
		// dispatcher schedules its handlers): the response is the last message
		// of the exchange — every session/update precedes it.
		const exchange = reconnected.wire.slice(wireMark);
		const responseIndex = exchange.findIndex(isResponse);
		const lastUpdateIndex = exchange.reduce((last, message, index) => (isSessionUpdate(message) ? index : last), -1);
		expect(responseIndex).toBeGreaterThanOrEqual(0);
		expect(lastUpdateIndex).toBeGreaterThanOrEqual(0);
		expect(responseIndex).toBeGreaterThan(lastUpdateIndex);

		// ORDERING, as the client saw it: the count captured the instant the
		// request resolved already covers the whole history — and nothing
		// trailed in afterwards, so that count is the complete transcript rather
		// than "however much happened to have arrived".
		expect(reconnected.notifications.length).toBe(notificationsAtResolve);
		expect(exchange.filter(isSessionUpdate)).toHaveLength(notificationsAtResolve);

		// Every replayed update, in transcript order. `available_commands_update`
		// leads because a loaded session is bound exactly like a created one.
		expect(reconnected.notifications.map((notification) => notification.update.sessionUpdate)).toEqual([
			"available_commands_update",
			"user_message_chunk",
			"agent_thought_chunk",
			"agent_message_chunk",
			"tool_call",
			"agent_message_chunk",
		]);
		expect(reconnected.notifications.every((notification) => notification.sessionId === sessionId)).toBe(true);
		expect(reconnected.chunkText("user_message_chunk")).toBe(USER_TEXT);
		expect(reconnected.chunkText("agent_thought_chunk")).toBe(THOUGHT_TEXT);
		expect(reconnected.chunkText("agent_message_chunk")).toBe(`${PREAMBLE_TEXT}${FINAL_TEXT}`);
	});

	it("replays the completed tool call through the live tool-call mapping", async () => {
		const dirs = sharedDirs();
		const sessionId = await seedSession(dirs);

		const reconnected = await openHarness({ dirs });
		await reconnected.initialize();
		await reconnected.loadSession(sessionId);

		const [toolCall] = reconnected.updatesOfType("tool_call");
		expect(toolCall).toBeDefined();
		expect(toolCall.kind).toBe("read");
		expect(toolCall.title).toBe("Read note.txt");
		expect(toolCall.status).toBe("completed");
		expect(toolCall.locations).toEqual([{ path: join(dirs.cwd, "note.txt") }]);
		expect(toolCall.rawInput).toEqual({ path: "note.txt" });
		expect(JSON.stringify(toolCall.content)).toContain("SENTINEL-NOTE-BODY");
	});

	it("carries the replayed history into the next prompt's model context", async () => {
		const dirs = sharedDirs();
		const sessionId = await seedSession(dirs);

		let followUpContext: Context | undefined;
		const reconnected = await openHarness({
			dirs,
			responses: [
				(context) => {
					followUpContext = context;
					return fauxAssistantMessage("Yes, I remember the note.");
				},
			],
		});
		await reconnected.initialize();
		await reconnected.loadSession(sessionId);

		const response = await reconnected.prompt(sessionId, "what did the note say?");

		expect(response.stopReason).toBe("end_turn");
		// The only proof the history reached the *model*, not just the client.
		const contextJson = JSON.stringify(followUpContext?.messages ?? []);
		expect(contextJson).toContain(USER_TEXT);
		expect(contextJson).toContain(PREAMBLE_TEXT);
		expect(contextJson).toContain(FINAL_TEXT);
		expect(contextJson).toContain("SENTINEL-NOTE-BODY");
		expect(contextJson).toContain("what did the note say?");
	});

	it("loads a session whose original cwd is gone, using the client cwd override", async () => {
		const dirs = sharedDirs("original-cwd");
		const sessionId = await seedSession(dirs);
		// The directory the session was recorded in no longer exists; only the
		// cwd the client sends with session/load does.
		rmSync(dirs.cwd, { recursive: true, force: true });
		const replacementCwd = resolve(dirs.sessionDir, "..", "replacement-cwd");
		mkdirSync(replacementCwd, { recursive: true });

		const reconnected = await openHarness({ dirs: { ...dirs, cwd: replacementCwd } });
		await reconnected.initialize();
		await reconnected.loadSession(sessionId);

		expect(reconnected.chunkText("user_message_chunk")).toBe(USER_TEXT);
		expect(reconnected.agent.agent.sessions.get(sessionId)?.runtime.cwd).toBe(replacementCwd);
	});

	it("installs the rebind hook on a loaded session, like a created one", async () => {
		const dirs = sharedDirs();
		const sessionId = await seedSession(dirs);

		const reconnected = await openHarness({ dirs, responses: [fauxAssistantMessage("Still here.")] });
		await reconnected.initialize();
		await reconnected.loadSession(sessionId);
		const handle = reconnected.agent.agent.sessions.get(sessionId);
		expect(handle).toBeDefined();

		// Extension-driven session replacement (/new, fork) swaps the underlying
		// AgentSession; without the rebind hook the ACP session goes silent.
		const beforeReplacement = reconnected.notifications.length;
		await handle?.runtime.newSession();

		// The rebind republishes the command set for the same ACP session id
		// (this rejects on timeout if the hook was never installed).
		await reconnected.waitForNotification(
			(notification) =>
				notification.sessionId === sessionId && notification.update.sessionUpdate === "available_commands_update",
			{ after: beforeReplacement, timeoutMs: 2_000 },
		);

		// The same ACP session id keeps streaming over the replacement session.
		const response = await reconnected.prompt(sessionId, "are you there?");
		expect(response.stopReason).toBe("end_turn");
		expect(chunkTextFor(reconnected, sessionId, "agent_message_chunk")).toContain("Still here.");
	});

	it("re-loading a session that is already open resyncs it in place", async () => {
		const dirs = sharedDirs();
		const sessionId = await seedSession(dirs);

		const reconnected = await openHarness({ dirs });
		await reconnected.initialize();
		await reconnected.loadSession(sessionId);
		const handle = reconnected.agent.agent.sessions.get(sessionId);
		const afterFirstLoad = reconnected.notifications.length;

		await reconnected.loadSession(sessionId);

		// One ACP session id keeps one runtime: the second load re-streams the
		// live session's history instead of tearing down a possibly busy one, and
		// does not re-announce the command set the client already has.
		expect(reconnected.agent.agent.sessions.get(sessionId)).toBe(handle);
		expect(reconnected.notifications.slice(afterFirstLoad).map((n) => n.update.sessionUpdate)).toEqual([
			"user_message_chunk",
			"agent_thought_chunk",
			"agent_message_chunk",
			"tool_call",
			"agent_message_chunk",
		]);
	});

	it("rejects session/load for an unknown session id with a JSON-RPC error", async () => {
		const harness = await openHarness({});
		await harness.initialize();

		await expect(harness.loadSession("00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
			code: -32602,
		});
		expect(harness.notifications).toHaveLength(0);
	});

	it("keeps two concurrent sessions' updates and turns independent", async () => {
		const harness = await openHarness({
			tokensPerSecond: 400,
			responses: [contextualResponder, contextualResponder],
		});
		const alpha = await harness.openSession();
		const beta = await harness.openSession();

		const [alphaResponse, betaResponse] = await Promise.all([
			harness.prompt(alpha, "say alpha"),
			harness.prompt(beta, "say beta"),
		]);

		expect(alphaResponse.stopReason).toBe("end_turn");
		expect(betaResponse.stopReason).toBe("end_turn");
		expect(alpha).not.toBe(beta);

		// Neither session's chunks leaked into the other's stream.
		expect(chunkTextFor(harness, alpha, "agent_message_chunk")).toBe(ALPHA_TEXT);
		expect(chunkTextFor(harness, beta, "agent_message_chunk")).toBe(BETA_TEXT);
		expect(harness.notifications.every((notification) => [alpha, beta].includes(notification.sessionId))).toBe(true);

		// The two streams really did interleave (more than one contiguous run per
		// session), so the isolation above was exercised concurrently.
		const order = notificationsOfType(harness, "agent_message_chunk").map((notification) => notification.sessionId);
		expect(countRuns(order)).toBeGreaterThan(2);
	});

	it("session/cancel cancels only its own session's turn", async () => {
		const harness = await openHarness({
			tokensPerSecond: 30,
			responses: [contextualResponder, contextualResponder],
		});
		const alpha = await harness.openSession();
		const beta = await harness.openSession();

		const alphaPrompt = harness.prompt(alpha, "say alpha");
		const betaPrompt = harness.prompt(beta, "say beta");
		let betaSettled = false;
		void betaPrompt.then(() => {
			betaSettled = true;
		});
		await harness.waitForNotification((notification) => isChunkFor(notification, alpha));
		await harness.waitForNotification((notification) => isChunkFor(notification, beta));

		await harness.cancel(alpha);
		expect((await alphaPrompt).stopReason).toBe("cancelled");
		const alphaSettledAt = harness.notifications.length;

		// Beta's turn is untouched: still pending, still streaming, still emitting.
		expect(betaSettled).toBe(false);
		expect(harness.agent.agent.sessions.get(beta)?.runtime.session.isStreaming).toBe(true);
		await harness.waitForNotification((notification) => isChunkFor(notification, beta), { after: alphaSettledAt });
		// ...while alpha's is finished: no further updates for it.
		expect(harness.notifications.slice(alphaSettledAt).some((n) => n.sessionId === alpha)).toBe(false);
		expect(chunkTextFor(harness, alpha, "agent_message_chunk").length).toBeLessThan(ALPHA_TEXT.length);

		await harness.cancel(beta);
		expect((await betaPrompt).stopReason).toBe("cancelled");
		expect(chunkTextFor(harness, beta, "agent_message_chunk").length).toBeLessThanOrEqual(BETA_TEXT.length);
	});
});

/**
 * Answers according to which session's prompt is in the request context.
 *
 * The faux queue is shared by both sessions and drains in call order, so a
 * fixed response list could not tell the two concurrent turns apart.
 */
function contextualResponder(context: Context) {
	return fauxAssistantMessage(JSON.stringify(context.messages).includes("say alpha") ? ALPHA_TEXT : BETA_TEXT);
}

function notificationsOfType(harness: AcpHarness, type: SessionUpdate["sessionUpdate"]): SessionNotification[] {
	return harness.notifications.filter((notification) => notification.update.sessionUpdate === type);
}

type ChunkUpdateType = "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";

function isChunkUpdate(update: SessionUpdate): update is Extract<SessionUpdate, { sessionUpdate: ChunkUpdateType }> {
	return (
		update.sessionUpdate === "agent_message_chunk" ||
		update.sessionUpdate === "agent_thought_chunk" ||
		update.sessionUpdate === "user_message_chunk"
	);
}

/** Like `harness.chunkText`, but scoped to one session id. */
function chunkTextFor(harness: AcpHarness, sessionId: string, type: ChunkUpdateType): string {
	let text = "";
	for (const notification of harness.notifications) {
		if (notification.sessionId !== sessionId) {
			continue;
		}
		const update = notification.update;
		if (isChunkUpdate(update) && update.sessionUpdate === type && update.content.type === "text") {
			text += update.content.text;
		}
	}
	return text;
}

function isChunkFor(notification: SessionNotification, sessionId: string): boolean {
	return notification.sessionId === sessionId && notification.update.sessionUpdate === "agent_message_chunk";
}

/** Number of contiguous same-value runs; > 2 means the two streams interleaved. */
function countRuns(values: string[]): number {
	let runs = 0;
	let previous: string | undefined;
	for (const value of values) {
		if (value !== previous) {
			runs++;
			previous = value;
		}
	}
	return runs;
}

function isResponse(message: AnyMessage): boolean {
	const record = message as Record<string, unknown>;
	return !("method" in record) && ("result" in record || "error" in record);
}

function isSessionUpdate(message: AnyMessage): boolean {
	return (message as Record<string, unknown>).method === "session/update";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
