/**
 * Tool-call translation: pi tool events -> ACP `tool_call` / `tool_call_update`.
 *
 * This is the {@link AcpToolEventSink} implementation the event translator
 * routes all tool-related events through. Every update is handed back to the
 * translator's single delivery tail, so tool updates stay correctly interleaved
 * with message chunks and keep the outbound backpressure guarantees.
 *
 * Lifecycle for one tool call:
 *
 * - assistant `toolcall_end` -> `tool_call` in `pending` status, carrying the
 *   kind, title, absolute locations, `rawInput`, and (for edit/write) the
 *   diff content blocks derived *exactly* from the tool input.
 * - `tool_execution_start` -> `tool_call_update` with `in_progress`.
 * - `tool_execution_update` -> a **snapshot** `tool_call_update`. pi's
 *   `partialResult` is cumulative (see `core/tools/bash.ts` `emitOutputUpdate`,
 *   which sends the whole accumulated output every time) and ACP content
 *   *replaces*, so snapshots are forwarded verbatim — never diff-appended —
 *   throttled to at most one per {@link DEFAULT_THROTTLE_MS} per toolCallId,
 *   with the last pending snapshot always flushed before the terminal update.
 * - `tool_execution_end` -> `completed` / `failed` plus projected content and optional `rawOutput`.
 *
 * The pure `acpTool*` helpers are exported so M5's history replay can rebuild
 * completed tool calls from stored session entries through the same mapping.
 */

import { isAbsolute, relative } from "node:path";
import type { SessionUpdate, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AcpToolDefinition } from "../../core/extensions/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../../core/tools/truncate.ts";
import type { AcpAssistantToolEvent, AcpToolEventSink, AcpToolExecutionEvent } from "./event-translator.ts";

/** Minimum gap between snapshot updates for a single toolCallId. */
export const DEFAULT_THROTTLE_MS = 100;

const MAX_TITLE_LENGTH = 120;
const PROJECTION_FAILURE_MESSAGE = "ACP result projection failed.";

/** Structural view of a pi tool result (the events type them as `any`). */
type PiToolResult = AgentToolResult<unknown> | undefined;

export interface AcpToolCallMapperOptions {
	/** Queues one `session/update` on the translator's ordered delivery tail. */
	sendUpdate: (update: SessionUpdate) => void;
	/** Current session cwd — ACP locations must be absolute. */
	getCwd: () => string;
	/** Resolve the current tool definition. Missing definitions use compatibility defaults. */
	getToolDefinition?: (name: string) => AcpToolDefinition | undefined;
	/** Snapshot throttle window per toolCallId. Default {@link DEFAULT_THROTTLE_MS}. */
	throttleMs?: number;
}

interface ToolCallState {
	/** Whether the `tool_call` (pending) update has been sent. */
	announced: boolean;
	/** Input-derived content (edit/write diffs); replayed on completion. */
	inputContent?: ToolCallContent[];
	/** Timestamp of the last snapshot handed to the delivery tail. */
	lastSnapshotAt: number;
	/** Snapshot withheld by the throttle, superseded by any newer snapshot. */
	pendingSnapshot?: ToolCallContent[];
	timer?: ReturnType<typeof setTimeout>;
}

export class AcpToolCallMapper implements AcpToolEventSink {
	private readonly sendUpdate: (update: SessionUpdate) => void;
	private readonly getCwd: () => string;
	private readonly getToolDefinition: (name: string) => AcpToolDefinition | undefined;
	private readonly throttleMs: number;
	private readonly calls = new Map<string, ToolCallState>();

	constructor(options: AcpToolCallMapperOptions) {
		this.sendUpdate = options.sendUpdate;
		this.getCwd = options.getCwd;
		this.getToolDefinition = options.getToolDefinition ?? (() => undefined);
		this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	}

	/** Assistant streaming events: `toolcall_end` announces the pending call. */
	onAssistantToolEvent(event: AcpAssistantToolEvent): void {
		if (event.type !== "toolcall_end") {
			return;
		}
		this.announce(event.toolCall.id, event.toolCall.name, event.toolCall.arguments);
	}

	/** Session-level tool execution lifecycle. */
	onToolExecutionEvent(event: AcpToolExecutionEvent): void {
		switch (event.type) {
			case "tool_execution_start":
				// Providers that do not stream tool calls never emit `toolcall_end`;
				// announcing here keeps the pending -> in_progress -> terminal
				// sequence intact either way.
				this.announce(event.toolCallId, event.toolName, event.args);
				this.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: "in_progress" });
				break;
			case "tool_execution_update":
				this.handleSnapshot(event.toolCallId, event.toolName, event.args, event.partialResult as PiToolResult);
				break;
			case "tool_execution_end":
				this.handleEnd(event.toolCallId, event.toolName, event.result as PiToolResult, event.isError);
				break;
		}
	}

	/** Drop all per-call state and cancel throttle timers (rebind, shutdown). */
	dispose(): void {
		for (const state of this.calls.values()) {
			this.clearTimer(state);
		}
		this.calls.clear();
	}

	private announce(toolCallId: string, toolName: string, args: unknown): ToolCallState {
		const state = this.ensureState(toolCallId);
		if (state.announced) {
			return state;
		}
		const cwd = this.getCwd();
		const definition = this.getToolDefinition(toolName);
		const locations = acpToolCallLocations(toolName, args, cwd);
		const inputContent = acpToolInputContent(toolName, args, cwd);
		state.announced = true;
		state.inputContent = inputContent;
		this.sendUpdate({
			sessionUpdate: "tool_call",
			toolCallId,
			title: acpToolCallTitle(toolName, args, cwd),
			kind: definition?.acpKind ?? acpToolKind(toolName),
			status: "pending",
			...(locations ? { locations } : {}),
			...(inputContent ? { content: inputContent } : {}),
			...(args === undefined || definition?.acpRawInput === false ? {} : { rawInput: args }),
		});
		return state;
	}

	private handleSnapshot(toolCallId: string, toolName: string, args: unknown, partialResult: PiToolResult): void {
		const state = this.announce(toolCallId, toolName, args);
		const { content } = projectAcpToolResult(partialResult, this.getToolDefinition(toolName), false);
		if (content.length === 0) {
			// Nothing to show yet (pi's bash tool opens with an empty snapshot);
			// clearing the client's content here would only cause a flicker.
			return;
		}
		const now = Date.now();
		const elapsed = now - state.lastSnapshotAt;
		if (elapsed >= this.throttleMs) {
			this.clearTimer(state);
			state.pendingSnapshot = undefined;
			this.flushSnapshot(toolCallId, state, content, now);
			return;
		}
		// Cumulative snapshots replace each other, so the newest one simply
		// supersedes whatever is waiting.
		state.pendingSnapshot = content;
		if (!state.timer) {
			state.timer = setTimeout(() => {
				state.timer = undefined;
				const queued = state.pendingSnapshot;
				state.pendingSnapshot = undefined;
				if (queued) {
					this.flushSnapshot(toolCallId, state, queued, Date.now());
				}
			}, this.throttleMs - elapsed);
		}
	}

	private handleEnd(toolCallId: string, toolName: string, result: PiToolResult, isError: boolean): void {
		const state = this.announce(toolCallId, toolName, undefined);
		this.clearTimer(state);
		// Always flush the final snapshot: a throttled snapshot must never be
		// dropped, even when the terminal content supersedes it.
		const withheld = state.pendingSnapshot;
		state.pendingSnapshot = undefined;
		if (withheld) {
			this.flushSnapshot(toolCallId, state, withheld, Date.now());
		}

		const definition = this.getToolDefinition(toolName);
		const projection = projectAcpToolResult(result, definition, isError);
		const content = projection.failed
			? projection.content
			: acpToolTerminalContent({
					isError,
					inputContent: state.inputContent,
					resultContent: projection.content,
				});
		this.calls.delete(toolCallId);
		this.sendUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: isError ? "failed" : "completed",
			...(content.length > 0 ? { content } : {}),
			...(projection.failed || definition?.acpRawOutput === false
				? {}
				: { rawOutput: { isError, content: result?.content ?? [], details: result?.details } }),
		});
	}

	private flushSnapshot(toolCallId: string, state: ToolCallState, content: ToolCallContent[], sentAt: number): void {
		state.lastSnapshotAt = sentAt;
		this.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId, content });
	}

	private ensureState(toolCallId: string): ToolCallState {
		let state = this.calls.get(toolCallId);
		if (!state) {
			state = { announced: false, lastSnapshotAt: 0 };
			this.calls.set(toolCallId, state);
		}
		return state;
	}

	private clearTimer(state: ToolCallState): void {
		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = undefined;
		}
	}
}

/** PLAN.md kind mapping; anything unrecognized (extension tools) is `other`. */
export function acpToolKind(toolName: string): ToolKind {
	switch (toolName) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		case "bash":
			return "execute";
		case "grep":
		case "find":
		case "ls":
			return "search";
		default:
			return "other";
	}
}

/** Human-readable title for a tool call, derived from its input. */
export function acpToolCallTitle(toolName: string, args: unknown, cwd: string): string {
	const record = asRecord(args);
	const rawPath = pathArgument(record);
	const display = rawPath === undefined ? undefined : displayPath(resolveToCwd(rawPath, cwd), cwd);
	switch (toolName) {
		case "read":
			return display ? `Read ${display}` : "Read";
		case "edit":
			return display ? `Edit ${display}` : "Edit";
		case "write":
			return display ? `Write ${display}` : "Write";
		case "bash": {
			const command = stringField(record, "command");
			return command ? commandTitle(command) : "bash";
		}
		case "grep": {
			const pattern = stringField(record, "pattern");
			const base = pattern ? `Search "${pattern}"` : "Search";
			return truncate(display ? `${base} in ${display}` : base, MAX_TITLE_LENGTH);
		}
		case "find": {
			const pattern = stringField(record, "pattern");
			const base = pattern ? `Find ${pattern}` : "Find";
			return truncate(display ? `${base} in ${display}` : base, MAX_TITLE_LENGTH);
		}
		case "ls":
			return `List ${display ?? "."}`;
		default:
			return toolName;
	}
}

/**
 * Absolute file locations touched by a tool call ("follow along" in clients).
 *
 * Tool inputs may be relative; they are resolved against the session cwd with
 * the same helper the tools themselves use.
 */
export function acpToolCallLocations(toolName: string, args: unknown, cwd: string): ToolCallLocation[] | undefined {
	const record = asRecord(args);
	const rawPath = pathArgument(record);
	if (rawPath === undefined) {
		return undefined;
	}
	const absolutePath = resolveToCwd(rawPath, cwd);
	switch (toolName) {
		case "read": {
			const line = numberField(record, "offset");
			return [line === undefined ? { path: absolutePath } : { path: absolutePath, line }];
		}
		case "edit":
		case "write":
		case "grep":
		case "find":
		case "ls":
			return [{ path: absolutePath }];
		default:
			return undefined;
	}
}

/**
 * Content blocks that follow from the tool *input* alone.
 *
 * `edit` becomes one ACP `diff` block per requested replacement and `write` a
 * single `diff` with a null `oldText` (new-file semantics) — both derived
 * exactly from the input, never by re-reading the file.
 */
export function acpToolInputContent(toolName: string, args: unknown, cwd: string): ToolCallContent[] | undefined {
	const record = asRecord(args);
	const rawPath = pathArgument(record);
	if (!record || rawPath === undefined) {
		return undefined;
	}
	const path = resolveToCwd(rawPath, cwd);
	if (toolName === "write") {
		const content = stringField(record, "content");
		return content === undefined ? undefined : [{ type: "diff", path, oldText: null, newText: content }];
	}
	if (toolName === "edit") {
		const edits = editPairs(record);
		if (edits.length === 0) {
			return undefined;
		}
		return edits.map((edit) => ({ type: "diff", path, oldText: edit.oldText, newText: edit.newText }));
	}
	return undefined;
}

/**
 * Choose the content blocks for a finished tool call.
 *
 * A successful edit/write is best represented by its input-derived diffs;
 * everything else — and every failure — shows the recorded result content.
 * Shared by the live path and `history-replay.ts` so a replayed tool call cannot
 * drift from the one the client saw execute.
 */
export function acpToolTerminalContent(options: {
	isError: boolean;
	inputContent: ToolCallContent[] | undefined;
	resultContent: ToolCallContent[];
}): ToolCallContent[] {
	return !options.isError && options.inputContent ? options.inputContent : options.resultContent;
}

/**
 * Map a pi tool result's model-facing content onto bounded ACP display content.
 *
 * ACP defines tool-call `content` as displayable information and `rawOutput` as
 * the complete raw result. Keep the model-facing result untouched, but cap the
 * text copied into client fragments to the same limits pi tools use for model
 * output. Unless the tool opts out, the caller separately places the complete
 * result in `rawOutput`.
 */
export interface AcpToolResultProjection {
	content: ToolCallContent[];
	failed: boolean;
}

/** Project a result and report whether a custom hook failed closed. */
export function projectAcpToolResult(
	result: PiToolResult,
	definition?: AcpToolDefinition,
	isError = false,
): AcpToolResultProjection {
	let content = result?.content ?? [];
	let failed = false;
	if (result && definition?.acpResultContent) {
		try {
			const projectionInput: AgentToolResult<unknown> = structuredClone({
				content: result.content,
				details: result.details,
			});
			content = definition.acpResultContent(projectionInput, { isError });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`ACP: result projection failed for ${definition.name}: ${message}`);
			content = [{ type: "text", text: PROJECTION_FAILURE_MESSAGE }];
			failed = true;
		}
	}
	return {
		content: boundedAcpToolResultContent(content, !failed && definition?.acpRawOutput !== false),
		failed,
	};
}

function boundedAcpToolResultContent(
	content: NonNullable<AgentToolResult<unknown>["content"]>,
	completeResultInRawOutput: boolean,
): ToolCallContent[] {
	const blocks: ToolCallContent[] = [];
	let remainingBytes = DEFAULT_MAX_BYTES;
	let remainingLines = DEFAULT_MAX_LINES;
	let textTruncated = false;
	for (const item of content) {
		if (item.type === "text") {
			if (!item.text) {
				continue;
			}
			if (textTruncated || remainingBytes <= 0 || remainingLines <= 0) {
				textTruncated = true;
				continue;
			}
			const display = truncateHead(item.text, {
				maxBytes: remainingBytes,
				maxLines: remainingLines,
			});
			if (display.content) {
				blocks.push({ type: "content", content: { type: "text", text: display.content } });
			}
			remainingBytes -= display.outputBytes;
			remainingLines -= display.outputLines;
			textTruncated = display.truncated;
		} else if (item.type === "image") {
			blocks.push({ type: "content", content: { type: "image", data: item.data, mimeType: item.mimeType } });
		}
	}
	if (textTruncated) {
		blocks.push({
			type: "content",
			content: {
				type: "text",
				text: `\n\n[ACP display truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.${completeResultInRawOutput ? " Complete result is preserved in rawOutput." : ""}]`,
			},
		});
	}
	return blocks;
}

interface EditPair {
	oldText: string;
	newText: string;
}

/**
 * Extract `{oldText, newText}` pairs from an edit tool input.
 *
 * Mirrors `prepareEditArguments` in `core/tools/edit.ts`: `edits` may arrive as
 * a JSON string, and a legacy top-level `{oldText, newText}` form is appended
 * after the array entries.
 */
function editPairs(record: Record<string, unknown>): EditPair[] {
	let raw = record.edits;
	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				raw = parsed;
			}
		} catch {
			// Leave `raw` alone; a malformed input simply yields no diffs.
		}
	}
	const pairs: EditPair[] = [];
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			const edit = asRecord(entry);
			if (edit && typeof edit.oldText === "string" && typeof edit.newText === "string") {
				pairs.push({ oldText: edit.oldText, newText: edit.newText });
			}
		}
	}
	if (typeof record.oldText === "string" && typeof record.newText === "string") {
		pairs.push({ oldText: record.oldText, newText: record.newText });
	}
	return pairs;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `read` accepts both key spellings; other path tools use `path`. */
function pathArgument(record: Record<string, unknown> | undefined): string | undefined {
	return stringField(record, "file_path") ?? stringField(record, "path");
}

function displayPath(absolutePath: string, cwd: string): string {
	const relativePath = relative(cwd, absolutePath);
	if (!relativePath) {
		return ".";
	}
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		return absolutePath;
	}
	return relativePath;
}

function commandTitle(command: string): string {
	const lines = command.trim().split("\n");
	const first = lines[0] ?? "";
	return truncate(lines.length > 1 ? `${first} …` : first, MAX_TITLE_LENGTH);
}

function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
