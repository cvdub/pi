/**
 * M2 acceptance tests for ACP mode: tool-call translation.
 *
 * Tool calls run the *real* local tools (read/bash/edit/write) inside the
 * harness's temp cwd — the faux provider only scripts which tool the model
 * asks for. That keeps the assertions honest about kinds, titles, absolute
 * locations, input-derived diffs, and the cumulative-snapshot contract.
 *
 * The `AcpToolCallMapper` throttling block drives the mapper directly with
 * fake timers so the ">=100ms per toolCallId, always flush the final snapshot"
 * rule is pinned deterministically instead of by wall-clock luck.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpToolCallMapper } from "../../src/modes/acp/tool-call-mapper.ts";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

type AcpToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

/** Statuses in arrival order, skipping content-only snapshot updates. */
function statusSequence(updates: AcpToolCallUpdate[]): string[] {
	const statuses: string[] = [];
	for (const update of updates) {
		if (update.status) {
			statuses.push(update.status);
		}
	}
	return statuses;
}

/** Concatenated text of the `content` blocks of one update. */
function contentText(content: ToolCallContent[] | null | undefined): string {
	let text = "";
	for (const block of content ?? []) {
		if (block.type === "content" && block.content.type === "text") {
			text += block.content.text;
		}
	}
	return text;
}

/** Content-only snapshot updates (no status), i.e. streamed partial results. */
/**
 * Strip the code fence wrapping output from tools that mark their text
 * preformatted, so assertions compare the payload rather than the framing.
 */
function unfenced(text: string): string {
	const fenced = text.match(/^(`{3,})\n([\s\S]*)\n\1$/);
	return fenced ? fenced[2] : text;
}

function snapshotTexts(updates: AcpToolCallUpdate[]): string[] {
	return updates
		.filter((update) => !update.status && update.content)
		.map((update) => unfenced(contentText(update.content)));
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("ACP tool-call translation (M2)", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("read yields pending -> in_progress -> completed with the read kind and an absolute location", async () => {
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "call-read" })]),
				fauxAssistantMessage("read it"),
			],
		});
		writeFileSync(join(harness.cwd, "notes.txt"), "alpha\nbeta\n");
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "read the notes");

		expect(response.stopReason).toBe("end_turn");
		const updates = harness.toolCallUpdates("call-read");
		expect(statusSequence(updates)).toEqual(["pending", "in_progress", "completed"]);

		const pending = updates[0];
		expect(pending.sessionUpdate).toBe("tool_call");
		expect(pending.kind).toBe("read");
		expect(pending.title).toBe("Read notes.txt");
		expect(pending.locations).toEqual([{ path: join(harness.cwd, "notes.txt") }]);
		expect(pending.rawInput).toEqual({ path: "notes.txt" });

		const completed = updates[updates.length - 1];
		expect(completed.sessionUpdate).toBe("tool_call_update");
		expect(contentText(completed.content)).toContain("alpha");
	});

	it("bash yields the execute kind titled by its command and reports no file locations", async () => {
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello-acp" }, { id: "call-bash" })]),
				fauxAssistantMessage("ran it"),
			],
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "run echo");

		expect(response.stopReason).toBe("end_turn");
		const updates = harness.toolCallUpdates("call-bash");
		expect(statusSequence(updates)).toEqual(["pending", "in_progress", "completed"]);

		const pending = updates[0];
		expect(pending.kind).toBe("execute");
		expect(pending.title).toBe("echo hello-acp");
		expect(pending.locations).toBeUndefined();
		expect(pending.rawInput).toEqual({ command: "echo hello-acp" });

		const completed = updates[updates.length - 1];
		expect(completed.status).toBe("completed");
		expect(contentText(completed.content)).toContain("hello-acp");
	});

	it("edit yields the edit kind and one diff content block per input edit", async () => {
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([
					fauxToolCall(
						"edit",
						{
							path: "src/app.ts",
							edits: [
								{ oldText: "alpha", newText: "ALPHA" },
								{ oldText: "gamma", newText: "GAMMA" },
							],
						},
						{ id: "call-edit" },
					),
				]),
				fauxAssistantMessage("edited"),
			],
		});
		mkdirSync(join(harness.cwd, "src"), { recursive: true });
		const absolutePath = join(harness.cwd, "src", "app.ts");
		writeFileSync(absolutePath, "alpha\nbeta\ngamma\n");
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "edit the file");

		expect(response.stopReason).toBe("end_turn");
		const updates = harness.toolCallUpdates("call-edit");
		expect(statusSequence(updates)).toEqual(["pending", "in_progress", "completed"]);

		const pending = updates[0];
		expect(pending.kind).toBe("edit");
		expect(pending.title).toBe("Edit src/app.ts");
		expect(pending.locations).toEqual([{ path: absolutePath }]);
		// Diffs are derived exactly from the tool input, never by re-reading.
		expect(pending.content).toEqual([
			{ type: "diff", path: absolutePath, oldText: "alpha", newText: "ALPHA" },
			{ type: "diff", path: absolutePath, oldText: "gamma", newText: "GAMMA" },
		]);

		const completed = updates[updates.length - 1];
		expect(completed.status).toBe("completed");
		expect(completed.content).toEqual(pending.content);
		expect(readFileSync(absolutePath, "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");
	});

	it("write yields the edit kind and a diff block with a null oldText", async () => {
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([
					fauxToolCall("write", { path: "generated/out.txt", content: "fresh content\n" }, { id: "call-write" }),
				]),
				fauxAssistantMessage("wrote"),
			],
		});
		const sessionId = await harness.openSession();
		const absolutePath = join(harness.cwd, "generated", "out.txt");

		const response = await harness.prompt(sessionId, "write the file");

		expect(response.stopReason).toBe("end_turn");
		const updates = harness.toolCallUpdates("call-write");
		expect(statusSequence(updates)).toEqual(["pending", "in_progress", "completed"]);

		const pending = updates[0];
		expect(pending.kind).toBe("edit");
		expect(pending.title).toBe("Write generated/out.txt");
		expect(pending.locations).toEqual([{ path: absolutePath }]);
		expect(pending.content).toEqual([
			{ type: "diff", path: absolutePath, oldText: null, newText: "fresh content\n" },
		]);

		expect(existsSync(absolutePath)).toBe(true);
		expect(readFileSync(absolutePath, "utf8")).toBe("fresh content\n");
	});

	it("a failing tool call ends in the failed status carrying the error text", async () => {
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "missing-file.txt" }, { id: "call-missing" })]),
				fauxAssistantMessage("could not read"),
			],
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "read a missing file");

		expect(response.stopReason).toBe("end_turn");
		const updates = harness.toolCallUpdates("call-missing");
		expect(statusSequence(updates)).toEqual(["pending", "in_progress", "failed"]);

		const failed = updates[updates.length - 1];
		expect(failed.status).toBe("failed");
		expect(contentText(failed.content)).toContain("missing-file.txt");
		expect(failed.rawOutput).toMatchObject({ isError: true });
	});

	it("streaming bash output yields replacing snapshots that are never duplicated or concatenated", async () => {
		const markers = ["chunk1", "chunk2", "chunk3", "chunk4", "chunk5"];
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([
					fauxToolCall(
						"bash",
						{ command: "for i in 1 2 3 4 5; do echo chunk$i; sleep 0.15; done" },
						{ id: "call-stream" },
					),
				]),
				fauxAssistantMessage("streamed"),
			],
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "stream some output");
		expect(response.stopReason).toBe("end_turn");

		const updates = harness.toolCallUpdates("call-stream");
		const snapshots = snapshotTexts(updates);
		// Throttling means fewer snapshots than output chunks, but more than one.
		expect(snapshots.length).toBeGreaterThanOrEqual(2);
		expect(snapshots.length).toBeLessThanOrEqual(markers.length + 2);

		// Each snapshot REPLACES the previous one: it is the previous snapshot
		// plus strictly more output, never the previous snapshot appended to
		// itself. This is the diff-append regression this milestone guards.
		for (let index = 1; index < snapshots.length; index++) {
			const previous = snapshots[index - 1];
			const current = snapshots[index];
			expect(current.startsWith(previous)).toBe(true);
			expect(current.length).toBeGreaterThan(previous.length);
		}

		const finalText = unfenced(contentText(updates[updates.length - 1]?.content));
		for (const text of [...snapshots, finalText]) {
			for (const marker of markers) {
				expect(occurrences(text, marker)).toBeLessThanOrEqual(1);
			}
		}
		expect(statusSequence(updates)).toEqual(["pending", "in_progress", "completed"]);
		for (const marker of markers) {
			expect(occurrences(finalText, marker)).toBe(1);
		}
	}, 30_000);

	it("emits available_commands_update after session/new", async () => {
		harness = await createAcpHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-hello", {
						description: "Say hello from ACP",
						handler: async () => {},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		// The client only learns the id from the session/new response, so the
		// announcement must not race ahead of it.
		expect(harness.updatesOfType("available_commands_update")).toHaveLength(0);
		await harness.waitForNotification(
			(notification) => notification.update.sessionUpdate === "available_commands_update",
		);

		const notification = harness.notifications.find(
			(entry) => entry.update.sessionUpdate === "available_commands_update",
		);
		expect(notification?.sessionId).toBe(sessionId);
		const updates = harness.updatesOfType("available_commands_update");
		expect(updates).toHaveLength(1);
		expect(updates[0].availableCommands).toEqual(
			expect.arrayContaining([{ name: "acp-hello", description: "Say hello from ACP" }]),
		);
	});
});

describe("AcpToolCallMapper snapshot throttling (M2)", () => {
	function drive(): { sent: SessionUpdate[]; mapper: AcpToolCallMapper } {
		const sent: SessionUpdate[] = [];
		const mapper = new AcpToolCallMapper({
			sendUpdate: (update) => sent.push(update),
			getCwd: () => "/work",
		});
		return { sent, mapper };
	}

	function toolUpdates(sent: SessionUpdate[]): AcpToolCallUpdate[] {
		return sent.filter(
			(update): update is AcpToolCallUpdate =>
				update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
		);
	}

	function shape(sent: SessionUpdate[]): Array<{ status: string | undefined; text: string }> {
		return toolUpdates(sent).map((update) => ({
			status: update.status ?? undefined,
			text: contentText(update.content),
		}));
	}

	function partial(text: string) {
		return { content: [{ type: "text" as const, text }], details: undefined };
	}

	it("coalesces rapid cumulative snapshots into one replacing update per 100ms window", () => {
		vi.useFakeTimers();
		try {
			const { sent, mapper } = drive();
			mapper.onToolExecutionEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo hi" },
			});
			for (const text of ["a", "ab", "abc", "abcd"]) {
				mapper.onToolExecutionEvent({
					type: "tool_execution_update",
					toolCallId: "t1",
					toolName: "bash",
					args: { command: "echo hi" },
					partialResult: partial(text),
				});
			}

			// First snapshot goes out immediately; the rest coalesce into the
			// LAST cumulative snapshot — not a concatenation of all of them.
			expect(shape(sent)).toEqual([
				{ status: "pending", text: "" },
				{ status: "in_progress", text: "" },
				{ status: undefined, text: "a" },
			]);
			vi.advanceTimersByTime(100);
			expect(shape(sent)).toEqual([
				{ status: "pending", text: "" },
				{ status: "in_progress", text: "" },
				{ status: undefined, text: "a" },
				{ status: undefined, text: "abcd" },
			]);
			mapper.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("always flushes the throttled final snapshot before the terminal update", () => {
		vi.useFakeTimers();
		try {
			const { sent, mapper } = drive();
			mapper.onToolExecutionEvent({
				type: "tool_execution_start",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo hi" },
			});
			mapper.onToolExecutionEvent({
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: partial("a"),
			});
			// Arrives inside the throttle window, so it is still pending when the
			// tool finishes.
			mapper.onToolExecutionEvent({
				type: "tool_execution_update",
				toolCallId: "t1",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: partial("ab"),
			});
			mapper.onToolExecutionEvent({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				result: partial("ab"),
				isError: false,
			});

			expect(shape(sent)).toEqual([
				{ status: "pending", text: "" },
				{ status: "in_progress", text: "" },
				{ status: undefined, text: "a" },
				{ status: undefined, text: "ab" },
				{ status: "completed", text: "ab" },
			]);
			// No throttle timer survives the terminal update.
			expect(vi.getTimerCount()).toBe(0);
			mapper.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("throttles each toolCallId independently", () => {
		vi.useFakeTimers();
		try {
			const { sent, mapper } = drive();
			for (const toolCallId of ["t1", "t2"]) {
				mapper.onToolExecutionEvent({
					type: "tool_execution_start",
					toolCallId,
					toolName: "bash",
					args: { command: "echo hi" },
				});
				mapper.onToolExecutionEvent({
					type: "tool_execution_update",
					toolCallId,
					toolName: "bash",
					args: { command: "echo hi" },
					partialResult: partial(`${toolCallId}-out`),
				});
			}

			// Both first snapshots pass the throttle: the window is per toolCallId.
			expect(snapshotTexts(toolUpdates(sent))).toEqual(["t1-out", "t2-out"]);
			mapper.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
