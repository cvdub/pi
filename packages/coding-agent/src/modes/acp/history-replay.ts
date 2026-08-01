/**
 * `session/load` history replay: stored pi session entries -> an ordered
 * `session/update` stream.
 *
 * What gets replayed is the *model's* view of the conversation, not the raw
 * file: `SessionManager.buildContextEntries()` (leaf path, compaction-aware) is
 * projected through the very same two functions the session context is built
 * with — `sessionEntryToContextMessages` and `convertToLlm` — so the transcript
 * the client renders after a load and the context the next prompt sends to the
 * model are derived from one source. Entries that never reach the model — labels,
 * model/thinking changes, plain custom entries, `!!`-excluded bash output — drop
 * out on their own; compaction and branch summaries survive as the prefixed user
 * messages the model actually receives. Two deliberate display rules apply after
 * that projection: hidden custom messages remain hidden, and tool-result text is
 * bounded for ACP display while the current tool definition controls whether the
 * complete result also appears in `rawOutput`.
 *
 * Completed tool calls are rebuilt through the exported helpers of
 * `tool-call-mapper.ts` (`acpToolKind`, `acpToolCallTitle`,
 * `acpToolCallLocations`, `acpToolInputContent`, `projectAcpToolResult`) plus the
 * currently installed tool definition, so replay applies the same projection
 * contract as the live call.
 *
 * Ordering contract: {@link streamSessionHistory} does not resolve until every
 * queued notification has been handed to the connection, and `session/load`
 * awaits it before returning. A client that renders on notifications therefore
 * has the complete transcript before its request resolves.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AcpToolDefinition } from "../../core/extensions/types.ts";
import { convertToLlm } from "../../core/messages.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../../core/session-manager.ts";
import { textBlock } from "./content.ts";
import type { AcpEventTranslator } from "./event-translator.ts";
import {
	acpToolCallLocations,
	acpToolCallTitle,
	acpToolInputContent,
	acpToolKind,
	acpToolTerminalContent,
	projectAcpToolResult,
} from "./tool-call-mapper.ts";

/**
 * Queue a session's full history on the translator's ordered delivery tail and
 * wait for it to drain.
 *
 * Both halves matter: the translator's single tail keeps the replayed updates
 * in transcript order, and awaiting the tail is what makes the history reach
 * the wire *before* the `session/load` response is written.
 */
export async function streamSessionHistory(options: {
	/** Leaf-path, compaction-aware entries (`SessionManager.buildContextEntries()`). */
	entries: SessionEntry[];
	/** Session cwd — ACP tool-call locations must be absolute. */
	cwd: string;
	/** The loaded session's translator (owns the sessionId and the delivery tail). */
	translator: AcpEventTranslator;
	/** Resolve the currently installed tool definition for replay projection. */
	getToolDefinition?: (name: string) => AcpToolDefinition | undefined;
}): Promise<void> {
	for (const update of buildHistoryUpdates(options.entries, options.cwd, options.getToolDefinition)) {
		options.translator.sendUpdate(update);
	}
	await options.translator.waitForDeliveries();
}

/**
 * Project stored session entries onto the ordered `session/update` list a
 * client needs to reconstruct the transcript.
 *
 * Pure: no I/O, no notification sending — the caller decides how to deliver.
 */
export function buildHistoryUpdates(
	entries: SessionEntry[],
	cwd: string,
	getToolDefinition: (name: string) => AcpToolDefinition | undefined = () => undefined,
): SessionUpdate[] {
	const messages = convertToLlm(entries.filter(isReplayableEntry).flatMap(sessionEntryToContextMessages));
	// Tool results are emitted as part of their originating tool call, which
	// appears earlier in the transcript, so they are indexed up front.
	const resultsByToolCallId = new Map<string, ToolResultMessage>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			resultsByToolCallId.set(message.toolCallId, message);
		}
	}

	const updates: SessionUpdate[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				updates.push(...userChunks(message));
				break;
			case "assistant":
				updates.push(...assistantUpdates(message, resultsByToolCallId, cwd, getToolDefinition));
				break;
			case "toolResult":
				// Already folded into its tool call above.
				break;
		}
	}
	return updates;
}

/**
 * Whether an entry may be shown to the client.
 *
 * An extension `custom_message` with `display: false` is deliberately hidden in
 * pi's own TUI. It *is* part of the model's context, but `convertToLlm` turns it
 * into a `user` message, so replaying it would surface concealed text to the
 * client in the user's own voice. An explicit request to stay hidden outranks
 * this module's transcript-equals-context rule.
 */
function isReplayableEntry(entry: SessionEntry): boolean {
	return !(entry.type === "custom_message" && entry.display === false);
}

/** User turns replay as `user_message_chunk`s, one per content part. */
function userChunks(message: UserMessage): SessionUpdate[] {
	const updates: SessionUpdate[] = [];
	if (typeof message.content === "string") {
		if (message.content) {
			updates.push({ sessionUpdate: "user_message_chunk", content: textBlock(message.content) });
		}
		return updates;
	}
	for (const part of message.content) {
		if (part.type === "text") {
			if (part.text) {
				updates.push({ sessionUpdate: "user_message_chunk", content: textBlock(part.text) });
			}
		} else {
			updates.push({
				sessionUpdate: "user_message_chunk",
				content: { type: "image", data: part.data, mimeType: part.mimeType },
			});
		}
	}
	return updates;
}

/**
 * Assistant turns replay as message chunks, thought chunks, and tool calls, in
 * the order the content was produced.
 */
function assistantUpdates(
	message: AssistantMessage,
	resultsByToolCallId: Map<string, ToolResultMessage>,
	cwd: string,
	getToolDefinition: (name: string) => AcpToolDefinition | undefined,
): SessionUpdate[] {
	const updates: SessionUpdate[] = [];
	for (const part of message.content) {
		switch (part.type) {
			case "text":
				if (part.text) {
					updates.push({ sessionUpdate: "agent_message_chunk", content: textBlock(part.text) });
				}
				break;
			case "thinking":
				if (part.thinking) {
					updates.push({ sessionUpdate: "agent_thought_chunk", content: textBlock(part.thinking) });
				}
				break;
			case "toolCall":
				updates.push(toolCallUpdate(part, resultsByToolCallId.get(part.id), cwd, getToolDefinition(part.name)));
				break;
		}
	}
	return updates;
}

/**
 * Rebuild one finished tool call as a single `tool_call` update.
 *
 * The live mapper's pending -> in_progress -> terminal sequence has no meaning
 * in replay, so the call is announced once in its terminal state. Content
 * follows the live rule exactly: a successful edit/write shows its
 * input-derived diffs, everything else shows the recorded result content.
 *
 * A call with no recorded result (the turn was interrupted before the tool
 * ran) stays `pending` — it never completed, and ACP has no better status for
 * "started but never finished".
 */
function toolCallUpdate(
	toolCall: ToolCall,
	result: ToolResultMessage | undefined,
	cwd: string,
	definition: AcpToolDefinition | undefined,
): SessionUpdate {
	const args = toolCall.arguments;
	const locations = acpToolCallLocations(toolCall.name, args, cwd);
	const inputContent = acpToolInputContent(toolCall.name, args, cwd);
	const isError = result?.isError === true;
	const projection = result
		? projectAcpToolResult({ content: result.content, details: result.details }, definition, isError)
		: undefined;
	const content = projection?.failed
		? projection.content
		: acpToolTerminalContent({ isError, inputContent, resultContent: projection?.content ?? [] });
	return {
		sessionUpdate: "tool_call",
		toolCallId: toolCall.id,
		title: acpToolCallTitle(toolCall.name, args, cwd),
		kind: definition?.acpKind ?? acpToolKind(toolCall.name),
		status: result === undefined ? "pending" : isError ? "failed" : "completed",
		...(locations ? { locations } : {}),
		...(content.length > 0 ? { content } : {}),
		...(args === undefined || definition?.acpRawInput === false ? {} : { rawInput: args }),
		...(result === undefined || projection?.failed || definition?.acpRawOutput === false
			? {}
			: { rawOutput: { isError, content: result.content, details: result.details } }),
	};
}
