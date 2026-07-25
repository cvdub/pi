/**
 * M3 acceptance tests for ACP mode: fs delegation.
 *
 * Tool calls run the *real* local tools (read/edit/write) inside the
 * harness's temp cwd, wired through `createAcpFsToolsOptions` (the same
 * function `runAcpMode` defaults to for real ACP sessions). The harness's
 * `client` override scripts the client-side `fs/read_text_file` /
 * `fs/write_text_file` handlers so each test can distinguish "the client's
 * buffer" from "what's actually on disk" and assert which one the model saw.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpFsToolsOptions } from "../../src/modes/acp/fs-delegation.ts";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

type AcpToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

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

function lastUpdate(updates: AcpToolCallUpdate[]): AcpToolCallUpdate {
	const update = updates[updates.length - 1];
	if (!update) {
		throw new Error("expected at least one tool-call update");
	}
	return update;
}

describe("ACP fs delegation (M3)", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("delegates text reads to the client, returning its buffer instead of disk", async () => {
		const readCalls: string[] = [];
		let followUpContext: Context | undefined;
		harness = await createAcpHarness({
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
			createToolsOptions: createAcpFsToolsOptions,
			client: {
				readTextFile: async (params) => {
					readCalls.push(params.path);
					return { content: "UNSAVED-BUFFER-CONTENT\n" };
				},
			},
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "call-read" })]),
				(context) => {
					followUpContext = context;
					return fauxAssistantMessage("read it");
				},
			],
		});
		const absolutePath = join(harness.cwd, "notes.txt");
		writeFileSync(absolutePath, "ON-DISK-CONTENT\n");
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "read the notes");

		expect(response.stopReason).toBe("end_turn");
		expect(readCalls).toEqual([absolutePath]);
		const seenByModel = JSON.stringify(followUpContext?.messages ?? []);
		expect(seenByModel).toContain("UNSAVED-BUFFER-CONTENT");
		expect(seenByModel).not.toContain("ON-DISK-CONTENT");
		// Delegation never touches disk on the read path.
		expect(readFileSync(absolutePath, "utf8")).toBe("ON-DISK-CONTENT\n");
	});

	it("round-trips edit through the client: delegated read of current content, delegated write of the result", async () => {
		const readCalls: string[] = [];
		const writeCalls: Array<{ path: string; content: string }> = [];
		harness = await createAcpHarness({
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
			createToolsOptions: createAcpFsToolsOptions,
			client: {
				readTextFile: async (params) => {
					readCalls.push(params.path);
					return { content: "Hello WORLD\n" };
				},
				writeTextFile: async (params) => {
					writeCalls.push({ path: params.path, content: params.content });
					return {};
				},
			},
			responses: [
				fauxAssistantMessage([
					fauxToolCall(
						"edit",
						{ path: "greeting.txt", edits: [{ oldText: "WORLD", newText: "EARTH" }] },
						{ id: "call-edit" },
					),
				]),
				fauxAssistantMessage("edited"),
			],
		});
		const absolutePath = join(harness.cwd, "greeting.txt");
		// Differs from the client's buffer so the edit's basis is unambiguous.
		writeFileSync(absolutePath, "Hello DISK\n");
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "edit the greeting");

		expect(response.stopReason).toBe("end_turn");
		expect(readCalls).toEqual([absolutePath]);
		expect(writeCalls).toEqual([{ path: absolutePath, content: "Hello EARTH\n" }]);
		const updates = harness.toolCallUpdates("call-edit");
		expect(lastUpdate(updates).status).toBe("completed");
		// The write was fully delegated to the client -- disk is untouched.
		expect(readFileSync(absolutePath, "utf8")).toBe("Hello DISK\n");
	});

	it("write creates parent directories locally, then delegates the file content to the client", async () => {
		const writeCalls: Array<{ path: string; content: string }> = [];
		harness = await createAcpHarness({
			clientCapabilities: { fs: { writeTextFile: true } },
			createToolsOptions: createAcpFsToolsOptions,
			client: {
				writeTextFile: async (params) => {
					writeCalls.push({ path: params.path, content: params.content });
					return {};
				},
			},
			responses: [
				fauxAssistantMessage([
					fauxToolCall("write", { path: "generated/nested/out.txt", content: "fresh\n" }, { id: "call-write" }),
				]),
				fauxAssistantMessage("wrote"),
			],
		});
		const sessionId = await harness.openSession();
		const absolutePath = join(harness.cwd, "generated", "nested", "out.txt");

		const response = await harness.prompt(sessionId, "write the file");

		expect(response.stopReason).toBe("end_turn");
		// mkdir has no ACP equivalent -- it always runs locally.
		expect(existsSync(join(harness.cwd, "generated", "nested"))).toBe(true);
		expect(writeCalls).toEqual([{ path: absolutePath, content: "fresh\n" }]);
		// The file write itself was fully delegated -- disk never got the content.
		expect(existsSync(absolutePath)).toBe(false);
	});

	it("with fs capabilities off, read/edit/write stay entirely local and no client fs method is called", async () => {
		const fsCalls: string[] = [];
		harness = await createAcpHarness({
			clientCapabilities: {},
			createToolsOptions: createAcpFsToolsOptions,
			client: {
				readTextFile: async () => {
					fsCalls.push("read");
					return { content: "SHOULD-NEVER-BE-USED" };
				},
				writeTextFile: async () => {
					fsCalls.push("write");
					return {};
				},
			},
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "call-read" })]),
				fauxAssistantMessage("read done"),
				fauxAssistantMessage([
					fauxToolCall(
						"edit",
						{ path: "notes.txt", edits: [{ oldText: "LOCAL", newText: "EDITED" }] },
						{ id: "call-edit" },
					),
				]),
				fauxAssistantMessage("edit done"),
				fauxAssistantMessage([
					fauxToolCall("write", { path: "generated/out.txt", content: "local write\n" }, { id: "call-write" }),
				]),
				fauxAssistantMessage("write done"),
			],
		});
		const notesPath = join(harness.cwd, "notes.txt");
		writeFileSync(notesPath, "LOCAL-DISK-CONTENT\n");
		const sessionId = await harness.openSession();

		const readResponse = await harness.prompt(sessionId, "read the notes");
		expect(readResponse.stopReason).toBe("end_turn");
		expect(contentText(lastUpdate(harness.toolCallUpdates("call-read")).content)).toContain("LOCAL-DISK-CONTENT");

		const editResponse = await harness.prompt(sessionId, "edit the notes");
		expect(editResponse.stopReason).toBe("end_turn");
		expect(readFileSync(notesPath, "utf8")).toBe("LOCAL-DISK-CONTENT\n".replace("LOCAL", "EDITED"));

		const writeResponse = await harness.prompt(sessionId, "write the file");
		expect(writeResponse.stopReason).toBe("end_turn");
		const outPath = join(harness.cwd, "generated", "out.txt");
		expect(existsSync(outPath)).toBe(true);
		expect(readFileSync(outPath, "utf8")).toBe("local write\n");

		expect(fsCalls).toEqual([]);
	});

	it("an image read bypasses fs delegation entirely and still reaches the model", async () => {
		const fsCalls: string[] = [];
		harness = await createAcpHarness({
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
			createToolsOptions: createAcpFsToolsOptions,
			client: {
				readTextFile: async (params) => {
					fsCalls.push(params.path);
					return { content: "should not be reached for images" };
				},
			},
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "image.png" }, { id: "call-image" })]),
				fauxAssistantMessage("saw the image"),
			],
		});
		const png1x1Base64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
		writeFileSync(join(harness.cwd, "image.png"), Buffer.from(png1x1Base64, "base64"));
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "read the image");

		expect(response.stopReason).toBe("end_turn");
		expect(fsCalls).toEqual([]);
		const completed = lastUpdate(harness.toolCallUpdates("call-image"));
		expect(completed.status).toBe("completed");
		const hasImageBlock = (completed.content ?? []).some(
			(block) => block.type === "content" && block.content.type === "image",
		);
		expect(hasImageBlock).toBe(true);
	});

	it("falls back to local disk when the client throws a RequestError for a delegated read", async () => {
		harness = await createAcpHarness({
			clientCapabilities: { fs: { readTextFile: true } },
			createToolsOptions: createAcpFsToolsOptions,
			client: {
				readTextFile: async () => {
					throw RequestError.internalError(undefined, "client declined to read");
				},
			},
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "call-read" })]),
				fauxAssistantMessage("read it"),
			],
		});
		const absolutePath = join(harness.cwd, "notes.txt");
		writeFileSync(absolutePath, "FALLBACK-DISK-CONTENT\n");
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "read the notes");

		expect(response.stopReason).toBe("end_turn");
		const completed = lastUpdate(harness.toolCallUpdates("call-read"));
		expect(completed.status).toBe("completed");
		expect(contentText(completed.content)).toContain("FALLBACK-DISK-CONTENT");
	});

	it("falls back to local disk when the client throws a RequestError for a delegated write", async () => {
		harness = await createAcpHarness({
			clientCapabilities: { fs: { writeTextFile: true } },
			createToolsOptions: createAcpFsToolsOptions,
			client: {
				writeTextFile: async () => {
					throw RequestError.internalError(undefined, "client declined to write");
				},
			},
			responses: [
				fauxAssistantMessage([
					fauxToolCall("write", { path: "out.txt", content: "fallback content\n" }, { id: "call-write" }),
				]),
				fauxAssistantMessage("wrote"),
			],
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "write the file");

		expect(response.stopReason).toBe("end_turn");
		const absolutePath = join(harness.cwd, "out.txt");
		expect(existsSync(absolutePath)).toBe(true);
		expect(readFileSync(absolutePath, "utf8")).toBe("fallback content\n");
	});
});
