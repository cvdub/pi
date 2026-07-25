/**
 * Translates AgentSessionEvents into ACP `session/update` notifications and
 * tracks pending `session/prompt` requests.
 *
 * M1 covers assistant text and thinking deltas plus the prompt lifecycle
 * (settle/cancel). Tool-related events are routed through the
 * {@link AcpToolEventSink} seam that M2's tool-call-mapper fills in.
 */

import type { StopReason as AcpStopReason, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { textBlock } from "./content.ts";

/** Assistant streaming events for tool calls (from message_update). */
export type AcpAssistantToolEvent = Extract<
	AssistantMessageEvent,
	{ type: "toolcall_start" | "toolcall_delta" | "toolcall_end" }
>;

/** Session-level tool execution lifecycle events. */
export type AcpToolExecutionEvent = Extract<
	AgentSessionEvent,
	{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

/**
 * Seam for M2's tool-call-mapper.
 *
 * The translator routes all tool-related events here instead of handling them
 * inline. Implementations send `tool_call` / `tool_call_update` updates back
 * through {@link AcpEventTranslator.sendUpdate} so ordering and backpressure
 * stay on the translator's single delivery tail.
 */
export interface AcpToolEventSink {
	onAssistantToolEvent?(event: AcpAssistantToolEvent): void;
	onToolExecutionEvent?(event: AcpToolExecutionEvent): void;
}

interface PendingPrompt {
	resolve: (stopReason: AcpStopReason) => void;
	reject: (error: unknown) => void;
}

/** A single registered `session/prompt` request. */
export interface PromptTurn {
	/** Resolves with the turn's stop reason at the next settle. */
	promise: Promise<AcpStopReason>;
	/** Reject this request (used for preflight failures) and stop tracking it. */
	fail(error: unknown): void;
}

/**
 * Tracks pending `session/prompt` requests for one ACP session.
 *
 * Multiple prompts can be pending at once (a mid-turn prompt steers the
 * active turn); all of them resolve together at the next settle. A
 * `session/cancel` marks the tracker so the settle resolves `cancelled`.
 */
export class PromptTurnTracker {
	private pending = new Set<PendingPrompt>();
	private cancelled = false;

	get hasPending(): boolean {
		return this.pending.size > 0;
	}

	register(): PromptTurn {
		let entry: PendingPrompt | undefined;
		const promise = new Promise<AcpStopReason>((resolve, reject) => {
			entry = { resolve, reject };
		});
		const registered = entry as PendingPrompt;
		this.pending.add(registered);
		return {
			promise,
			fail: (error: unknown) => {
				if (this.pending.delete(registered)) {
					registered.reject(error);
				}
			},
		};
	}

	/** Mark the in-flight turn as cancelled; the next settle resolves `cancelled`. */
	markCancelled(): void {
		this.cancelled = true;
	}

	/** Snapshot the currently pending prompts (settled later, after updates flush). */
	snapshot(): ReadonlySet<PendingPrompt> {
		return new Set(this.pending);
	}

	/**
	 * Resolve every snapshot member that is still pending. Prompts registered
	 * after the snapshot was taken keep waiting for their own settle.
	 */
	settleSnapshot(snapshot: ReadonlySet<PendingPrompt>): void {
		const stopReason: AcpStopReason = this.cancelled ? "cancelled" : "end_turn";
		this.cancelled = false;
		for (const entry of snapshot) {
			if (this.pending.delete(entry)) {
				entry.resolve(stopReason);
			}
		}
	}
}

export interface AcpEventTranslatorOptions {
	/** ACP session id stamped on every notification. */
	sessionId: string;
	/** Delivers one `session/update` notification (usually `conn.sessionUpdate`). */
	sendNotification: (notification: SessionNotification) => Promise<void>;
	/** Tracker resolved when the session settles. */
	tracker: PromptTurnTracker;
	/** Reports whether the current AgentSession is idle (no active run). */
	isSessionIdle: () => boolean;
	/** M2 seam: receives all tool-related events. */
	toolEventSink?: AcpToolEventSink;
}

/**
 * Per-session event translator.
 *
 * All outbound notifications are chained on a single delivery tail so they
 * reach the client in order; `waitForDeliveries` doubles as the outbound
 * backpressure hook registered on the agent (rpc-mode pattern).
 */
export class AcpEventTranslator {
	private readonly sessionId: string;
	private readonly sendNotification: (notification: SessionNotification) => Promise<void>;
	private readonly tracker: PromptTurnTracker;
	private readonly isSessionIdle: () => boolean;
	private readonly toolEventSink?: AcpToolEventSink;
	private deliveryTail: Promise<void> = Promise.resolve();

	constructor(options: AcpEventTranslatorOptions) {
		this.sessionId = options.sessionId;
		this.sendNotification = options.sendNotification;
		this.tracker = options.tracker;
		this.isSessionIdle = options.isSessionIdle;
		this.toolEventSink = options.toolEventSink;
	}

	/** Queue a `session/update` notification on the ordered delivery tail. */
	sendUpdate(update: SessionUpdate): void {
		this.deliveryTail = this.deliveryTail
			.then(() => this.sendNotification({ sessionId: this.sessionId, update }))
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`ACP: failed to send session/update: ${message}`);
			});
	}

	/** Resolve once every queued notification has been handed to the connection. */
	async waitForDeliveries(): Promise<void> {
		while (true) {
			const tail = this.deliveryTail;
			await tail;
			if (tail === this.deliveryTail) {
				return;
			}
		}
	}

	/** Session event entry point (wired via `session.subscribe`). */
	handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_update":
				this.handleAssistantEvent(event.assistantMessageEvent);
				break;
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end":
				this.toolEventSink?.onToolExecutionEvent?.(event);
				break;
			case "agent_settled":
				this.settle();
				break;
			default:
				break;
		}
	}

	/**
	 * Resolve pending prompts if the session is idle once all queued updates
	 * have flushed. Used for prompts that complete without an agent run (for
	 * example extension slash commands), which never emit `agent_settled`.
	 */
	settleIfIdle(): void {
		const snapshot = this.tracker.snapshot();
		void this.waitForDeliveries().then(() => {
			if (this.isSessionIdle()) {
				this.tracker.settleSnapshot(snapshot);
			}
		});
	}

	private settle(): void {
		const snapshot = this.tracker.snapshot();
		void this.waitForDeliveries().then(() => {
			this.tracker.settleSnapshot(snapshot);
		});
	}

	private handleAssistantEvent(event: AssistantMessageEvent): void {
		switch (event.type) {
			case "text_delta":
				if (event.delta) {
					this.sendUpdate({ sessionUpdate: "agent_message_chunk", content: textBlock(event.delta) });
				}
				break;
			case "thinking_delta":
				if (event.delta) {
					this.sendUpdate({ sessionUpdate: "agent_thought_chunk", content: textBlock(event.delta) });
				}
				break;
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				this.toolEventSink?.onAssistantToolEvent?.(event);
				break;
			default:
				break;
		}
	}
}
