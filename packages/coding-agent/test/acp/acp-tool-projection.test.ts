import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import { buildHistoryUpdates } from "../../src/modes/acp/history-replay.ts";
import { AcpToolCallMapper } from "../../src/modes/acp/tool-call-mapper.ts";

type AcpToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;
type ProjectionTool = ToolDefinition<typeof parameters, { summary: string }>;

const parameters = Type.Object({ query: Type.String() });

function contentText(content: ToolCallContent[] | null | undefined): string {
	return (content ?? [])
		.filter((block) => block.type === "content" && block.content.type === "text")
		.map((block) => (block.type === "content" && block.content.type === "text" ? block.content.text : ""))
		.join("");
}

function toolUpdates(sent: SessionUpdate[]): AcpToolCallUpdate[] {
	return sent.filter(
		(update): update is AcpToolCallUpdate =>
			update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update",
	);
}

function projectionTool(
	projection: ProjectionTool["acpResultContent"],
	policy: Pick<ProjectionTool, "acpKind" | "acpRawInput" | "acpRawOutput"> = {},
): ProjectionTool {
	return {
		name: "catalog",
		label: "Catalog",
		description: "Search the catalog",
		parameters,
		execute: async () => ({ content: [], details: { summary: "unused" } }),
		acpResultContent: projection,
		...policy,
	};
}

function driveMapper(
	tool: ProjectionTool | undefined,
	options: {
		isError?: boolean;
		includeSnapshot?: boolean;
		result?: AgentToolResult<{ summary: string }>;
	} = {},
): AcpToolCallUpdate[] {
	const sent: SessionUpdate[] = [];
	const mapper = new AcpToolCallMapper({
		sendUpdate: (update) => sent.push(update),
		getCwd: () => "/work",
		getToolDefinition: (name) => (name === tool?.name ? tool : undefined),
	});
	const args = { query: "books" };
	mapper.onToolExecutionEvent({
		type: "tool_execution_start",
		toolCallId: "call-catalog",
		toolName: "catalog",
		args,
	});
	if (options.includeSnapshot) {
		mapper.onToolExecutionEvent({
			type: "tool_execution_update",
			toolCallId: "call-catalog",
			toolName: "catalog",
			args,
			partialResult: { content: [{ type: "text", text: "model snapshot" }], details: { summary: "snapshot" } },
		});
	}
	mapper.onToolExecutionEvent({
		type: "tool_execution_end",
		toolCallId: "call-catalog",
		toolName: "catalog",
		result: options.result ?? {
			content: [{ type: "text", text: "complete model-facing output" }],
			details: { summary: "three matches" },
		},
		isError: options.isError ?? false,
	});
	return toolUpdates(sent);
}

function historyEntries(isError = false): SessionMessageEntry[] {
	return [
		{
			type: "message",
			id: "assistant-entry",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: fauxAssistantMessage([fauxToolCall("catalog", { query: "books" }, { id: "history-call" })]),
		},
		{
			type: "message",
			id: "result-entry",
			parentId: "assistant-entry",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "history-call",
				toolName: "catalog",
				content: [{ type: "text", text: "persisted model output" }],
				details: { summary: isError ? "history failure" : "history success" },
				addedToolNames: ["history-only-tool"],
				isError,
				timestamp: Date.now(),
			},
		},
	];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ACP tool-defined result projection", () => {
	it("projects a typed terminal result without changing the raw model result", () => {
		const result: AgentToolResult<{ summary: string }> = {
			content: [{ type: "text", text: "complete model-facing output" }],
			details: { summary: "three matches" },
		};
		const updates = driveMapper(
			projectionTool((projectionResult, { isError }) => {
				const summary = projectionResult.details.summary;
				projectionResult.details.summary = "mutated details";
				const text = projectionResult.content[0];
				if (text?.type === "text") text.text = "mutated content";
				return [{ type: "text", text: `${isError ? "error" : "ok"}: ${summary}` }];
			}),
			{ result },
		);

		const terminal = updates.at(-1);
		expect(contentText(terminal?.content)).toBe("ok: three matches");
		expect(terminal?.rawOutput).toEqual({ isError: false, ...result });
		expect(result).toEqual({
			content: [{ type: "text", text: "complete model-facing output" }],
			details: { summary: "three matches" },
		});
	});

	it("projects cumulative snapshots with isError false", () => {
		const projection = vi.fn<NonNullable<ProjectionTool["acpResultContent"]>>((result, { isError }) => [
			{ type: "text", text: `${isError}:${result.details.summary}` },
		]);
		const updates = driveMapper(projectionTool(projection), { includeSnapshot: true });
		const snapshot = updates.find((update) => update.status === undefined);

		expect(contentText(snapshot?.content)).toBe("false:snapshot");
		expect(projection).toHaveBeenCalledWith(expect.objectContaining({ details: { summary: "snapshot" } }), {
			isError: false,
		});
	});

	it("passes terminal error status to the projection and preserves failed execution status", () => {
		const updates = driveMapper(
			projectionTool((_result, { isError }) => [{ type: "text", text: isError ? "projected failure" : "success" }]),
			{ isError: true },
		);
		const terminal = updates.at(-1);

		expect(terminal?.status).toBe("failed");
		expect(contentText(terminal?.content)).toBe("projected failure");
		expect(terminal?.rawOutput).toMatchObject({ isError: true });
	});

	it("treats an empty projected terminal result as intentional suppression", () => {
		const terminal = driveMapper(projectionTool(() => [])).at(-1);

		expect(terminal?.status).toBe("completed");
		expect(terminal).not.toHaveProperty("content");
	});

	it("fails closed to a short diagnostic when projection mutates and throws", () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const result: AgentToolResult<{ summary: string }> = {
			content: [{ type: "text", text: "complete model-facing output" }],
			details: { summary: "three matches" },
		};
		const terminal = driveMapper(
			projectionTool((projectionResult) => {
				projectionResult.details.summary = "mutated details";
				const text = projectionResult.content[0];
				if (text?.type === "text") text.text = "mutated content";
				throw new Error("private projection stack detail");
			}),
			{ result },
		).at(-1);

		expect(terminal?.status).toBe("completed");
		expect(contentText(terminal?.content)).toBe("ACP result projection failed.");
		expect(contentText(terminal?.content)).not.toContain("complete model-facing output");
		expect(terminal).not.toHaveProperty("rawOutput");
		expect(result).toEqual({
			content: [{ type: "text", text: "complete model-facing output" }],
			details: { summary: "three matches" },
		});
		expect(logged).toHaveBeenCalledWith(expect.stringContaining("private projection stack detail"));
	});

	it("converts projected Pi image blocks to ACP content", () => {
		const terminal = driveMapper(
			projectionTool(() => [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]),
		).at(-1);

		expect(terminal?.content).toEqual([
			{ type: "content", content: { type: "image", data: "aW1hZ2U=", mimeType: "image/png" } },
		]);
	});

	it("keeps successful input-derived diffs ahead of projected result content", () => {
		const tool = { ...projectionTool(() => [{ type: "text", text: "projected result" }]), name: "edit" };
		const sent: SessionUpdate[] = [];
		const mapper = new AcpToolCallMapper({
			sendUpdate: (update) => sent.push(update),
			getCwd: () => "/work",
			getToolDefinition: (name) => (name === tool.name ? tool : undefined),
		});
		const args = { path: "note.txt", edits: [{ oldText: "old", newText: "new" }] };
		mapper.onToolExecutionEvent({
			type: "tool_execution_start",
			toolCallId: "call-edit",
			toolName: "edit",
			args,
		});
		mapper.onToolExecutionEvent({
			type: "tool_execution_end",
			toolCallId: "call-edit",
			toolName: "edit",
			result: { content: [{ type: "text", text: "model result" }], details: { summary: "edited" } },
			isError: false,
		});

		expect(toolUpdates(sent).at(-1)?.content).toEqual([
			{ type: "diff", path: "/work/note.txt", oldText: "old", newText: "new" },
		]);
	});

	it("applies the existing line and byte backstop to projected content", () => {
		const hiddenTail = "HOOK-TAIL-MUST-NOT-CROSS";
		const hugeProjection = `${"line\n".repeat(2_100)}${hiddenTail}`;
		const terminal = driveMapper(projectionTool(() => [{ type: "text", text: hugeProjection }])).at(-1);
		const text = contentText(terminal?.content);

		expect(text).toContain("[ACP display truncated to 2000 lines or 50.0KB.");
		expect(text).not.toContain(hiddenTail);
	});

	it("honors kind and raw-field declarations while defaults remain unchanged", () => {
		const declared = driveMapper(
			projectionTool(() => [], { acpKind: "think", acpRawInput: false, acpRawOutput: false }),
		);
		expect(declared[0].kind).toBe("think");
		expect(declared[0]).not.toHaveProperty("rawInput");
		expect(declared.at(-1)).not.toHaveProperty("rawOutput");

		const missing = driveMapper(undefined);
		expect(missing[0]).toMatchObject({ kind: "other", rawInput: { query: "books" } });
		expect(contentText(missing.at(-1)?.content)).toBe("complete model-facing output");
		expect(missing.at(-1)).toHaveProperty("rawOutput");
	});
});

describe("ACP tool-defined projection during history replay", () => {
	it("normalizes live and replay hook inputs to persisted content and details", () => {
		const tool = projectionTool((result) => [
			{
				type: "text",
				text: `${result.details.summary}:${result.addedToolNames?.join(",") ?? "no-added-tools"}:${result.terminate ?? false}`,
			},
		]);
		const liveResult: AgentToolResult<{ summary: string }> = {
			content: [{ type: "text", text: "live model output" }],
			details: { summary: "history success" },
			addedToolNames: ["live-only-tool"],
			terminate: true,
		};
		const live = driveMapper(tool, { result: liveResult }).at(-1);
		const [replayed] = buildHistoryUpdates(historyEntries(), "/work", (name) =>
			name === tool.name ? tool : undefined,
		) as AcpToolCallUpdate[];

		expect(contentText(live?.content)).toBe("history success:no-added-tools:false");
		expect(contentText(replayed.content)).toBe(contentText(live?.content));
	});

	it("replays current content, kind, and raw-field policy from persisted results", () => {
		const tool = projectionTool(
			(result, { isError }) => [{ type: "text", text: `${isError}:${result.details.summary}` }],
			{ acpKind: "fetch", acpRawInput: false, acpRawOutput: false },
		);
		const [update] = buildHistoryUpdates(historyEntries(), "/work", (name) =>
			name === tool.name ? tool : undefined,
		) as AcpToolCallUpdate[];

		expect(update).toMatchObject({ kind: "fetch", status: "completed" });
		expect(contentText(update.content)).toBe("false:history success");
		expect(update).not.toHaveProperty("rawInput");
		expect(update).not.toHaveProperty("rawOutput");
	});

	it("fails closed when replay projection throws", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const tool = projectionTool(() => {
			throw new Error("replay projection detail");
		});
		const [update] = buildHistoryUpdates(historyEntries(), "/work", (name) =>
			name === tool.name ? tool : undefined,
		) as AcpToolCallUpdate[];

		expect(contentText(update.content)).toBe("ACP result projection failed.");
		expect(update).not.toHaveProperty("rawOutput");
	});

	it("replays projection error status and falls back when the definition is missing", () => {
		const tool = projectionTool((result, { isError }) => [
			{ type: "text", text: `${isError}:${result.details.summary}` },
		]);
		const [projected] = buildHistoryUpdates(historyEntries(true), "/work", (name) =>
			name === tool.name ? tool : undefined,
		) as AcpToolCallUpdate[];
		expect(projected.status).toBe("failed");
		expect(contentText(projected.content)).toBe("true:history failure");

		const [fallback] = buildHistoryUpdates(historyEntries(), "/work") as AcpToolCallUpdate[];
		expect(fallback).toMatchObject({ kind: "other", rawInput: { query: "books" } });
		expect(contentText(fallback.content)).toBe("persisted model output");
		expect(fallback).toHaveProperty("rawOutput");
	});
});
