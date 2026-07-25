/**
 * Regression tests for defects found while reviewing M5.
 *
 * Each test here failed before its fix and would fail again if the fix were
 * reverted — they are guards, not documentation.
 *
 * - D1: a `session/cancel` that never reaches a settle must not leave the
 *   tracker's cancelled flag set, or the *next* prompt reports `cancelled`.
 * - D2: two concurrent `session/load` calls for one id must not each build a
 *   runtime; the loser would be orphaned and its transcript replayed twice.
 * - J1: an extension `custom_message` marked `display: false` is hidden in pi's
 *   TUI and must not be replayed to an ACP client, where `convertToLlm` would
 *   surface it as the user's own words.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { CustomMessageEntry } from "../../src/core/session-manager.ts";
import { PromptTurnTracker } from "../../src/modes/acp/event-translator.ts";
import { buildHistoryUpdates } from "../../src/modes/acp/history-replay.ts";
import { type AcpHarness, type AcpHarnessDirs, createAcpHarness } from "./acp-harness.ts";

const USER_TEXT = "remember this please";
const REPLY_TEXT = "noted";

function customEntry(id: string, content: string, display: boolean): CustomMessageEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom_message",
		customType: `injection-${id}`,
		content,
		display,
	};
}

describe("D1: cancelled flag does not leak into the next turn", () => {
	it("clears cancelled when a marked cancel's prompt fails before any settle", async () => {
		const tracker = new PromptTurnTracker();

		// Turn 1: registered, cancelled, then rejected by a preflight failure.
		// `session.abort()` on a session that never started running resolves
		// without emitting agent_settled, so no settle ever clears the flag.
		const first = tracker.register();
		tracker.markCancelled();
		const firstOutcome = first.promise.then(
			(reason) => `resolved:${reason}`,
			() => "rejected",
		);
		first.fail(new Error("preflight failed"));
		expect(tracker.hasPending).toBe(false);
		await expect(firstOutcome).resolves.toBe("rejected");

		// Turn 2: a normal turn that nobody cancelled must settle end_turn.
		const second = tracker.register();
		tracker.settleSnapshot(tracker.snapshot());
		await expect(second.promise).resolves.toBe("end_turn");
	});

	it("still reports cancelled for a turn that is cancelled and does settle", async () => {
		const tracker = new PromptTurnTracker();
		const turn = tracker.register();
		tracker.markCancelled();
		tracker.settleSnapshot(tracker.snapshot());
		await expect(turn.promise).resolves.toBe("cancelled");
	});
});

describe("J1: replay hides entries the TUI hides", () => {
	it("omits a display:false custom_message and keeps a display:true one", () => {
		const updates = buildHistoryUpdates(
			[customEntry("hidden", "CONCEALED-CONTEXT-NOTE", false), customEntry("shown", "VISIBLE-CONTEXT-NOTE", true)],
			"/work",
		);
		const text = JSON.stringify(updates);

		expect(text).not.toContain("CONCEALED-CONTEXT-NOTE");
		expect(text).toContain("VISIBLE-CONTEXT-NOTE");
	});
});

describe("D2: concurrent duplicate session/load", () => {
	const harnesses: AcpHarness[] = [];
	const roots: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.dispose();
		}
		for (const root of roots.splice(0)) {
			if (existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	function sharedDirs(): AcpHarnessDirs {
		const root = join(tmpdir(), `pi-acp-dup-load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		roots.push(root);
		const dirs = {
			cwd: join(root, "cwd"),
			sessionDir: join(root, "sessions"),
			agentDir: join(root, "agent"),
		};
		mkdirSync(dirs.cwd, { recursive: true });
		return dirs;
	}

	it("joins a racing duplicate load instead of building a second runtime", async () => {
		const dirs = sharedDirs();
		writeFileSync(join(dirs.cwd, "note.txt"), "body\n");

		// Seed a session on a first connection, then drop it.
		const seed = await createAcpHarness({ dirs, responses: [fauxAssistantMessage(REPLY_TEXT)] });
		harnesses.push(seed);
		const sessionId = await seed.openSession();
		expect((await seed.prompt(sessionId, USER_TEXT)).stopReason).toBe("end_turn");
		await seed.dispose();
		harnesses.pop();

		// Reconnect and fire two loads for the same id concurrently.
		const reconnected = await createAcpHarness({ dirs });
		harnesses.push(reconnected);
		await reconnected.initialize();
		await Promise.all([reconnected.loadSession(sessionId), reconnected.loadSession(sessionId)]);

		// One handle, and the transcript replayed exactly once: the user turn and
		// the assistant reply each appear a single time. Without the in-flight
		// guard both loads replay, doubling every chunk and orphaning a runtime.
		expect(reconnected.agent.agent.sessions.get(sessionId)).toBeDefined();
		expect(reconnected.chunkText("user_message_chunk")).toBe(USER_TEXT);
		expect(reconnected.chunkText("agent_message_chunk")).toBe(REPLY_TEXT);

		// And it still works afterwards.
		reconnected.faux.setResponses([fauxAssistantMessage("after")]);
		expect((await reconnected.prompt(sessionId, "again")).stopReason).toBe("end_turn");
	}, 30_000);
});
