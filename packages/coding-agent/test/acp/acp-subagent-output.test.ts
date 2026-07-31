import type { AnyMessage, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { type Context, fauxAssistantMessage, fauxToolCall, Type } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/index.ts";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

const REPORT_END = "\nSUBAGENT_REPORT_END";
const SMALL_REPORT_BYTES = 1_024;
const LARGE_REPORT_BYTES = 512 * 1_024;

function makeReport(bytes: number): string {
	const markdown = [
		"# Subagent report\n",
		"- [finding](https://example.test): model-facing evidence\n",
		'```typescript\nconst result = "complete";\n```\n',
	].join("");
	return `${markdown.repeat(Math.ceil(bytes / markdown.length)).slice(0, bytes - REPORT_END.length)}${REPORT_END}`;
}

function contentText(content: ToolCallContent[] | null | undefined): string {
	return (content ?? [])
		.filter(
			(block): block is Extract<ToolCallContent, { type: "content" }> =>
				block.type === "content" && block.content.type === "text",
		)
		.map((block) => (block.content.type === "text" ? block.content.text : ""))
		.join("");
}

function terminalSubagentUpdate(update: SessionUpdate): boolean {
	return (
		update.sessionUpdate === "tool_call_update" &&
		update.toolCallId === "call-subagent" &&
		update.status === "completed"
	);
}

function isResponse(message: AnyMessage): boolean {
	return "id" in message && ("result" in message || "error" in message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function subagentExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: "Return a configurable deterministic subagent report.",
			parameters: Type.Object({ bytes: Type.Number() }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text" as const, text: makeReport(params.bytes) }],
				details: { bytes: params.bytes },
			}),
		});
	};
}

describe("ACP custom subagent output", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("keeps a complete large report in model context without exposing it as complete ACP display content", async () => {
		const report = makeReport(LARGE_REPORT_BYTES);
		let followUpContext: Context | undefined;
		harness = await createAcpHarness({
			extensionFactories: [subagentExtension()],
			responses: [
				fauxAssistantMessage([fauxToolCall("subagent", { bytes: LARGE_REPORT_BYTES }, { id: "call-subagent" })]),
				(context) => {
					followUpContext = context;
					return fauxAssistantMessage("parent continued");
				},
			],
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "delegate");

		expect(response.stopReason).toBe("end_turn");
		expect(JSON.stringify(followUpContext?.messages ?? [])).toContain("SUBAGENT_REPORT_END");
		const terminal = harness.toolCallUpdates("call-subagent").find((update) => update.status === "completed");
		expect(terminal).toBeDefined();
		const display = contentText(terminal?.content);
		expect(display).not.toBe(report);
		expect(display).toContain("[ACP display truncated");
		expect(display).not.toContain(REPORT_END);
		expect(JSON.stringify(terminal?.rawOutput)).toContain("SUBAGENT_REPORT_END");
	});

	it.each([
		["small", SMALL_REPORT_BYTES],
		["large", LARGE_REPORT_BYTES],
	])("settles the prompt promptly after a %s terminal report reaches ACP", async (label, bytes) => {
		harness = await createAcpHarness({
			extensionFactories: [subagentExtension()],
			responses: [
				fauxAssistantMessage([fauxToolCall("subagent", { bytes }, { id: "call-subagent" })]),
				fauxAssistantMessage("parent continued"),
			],
		});
		const sessionId = await harness.openSession();
		const wireMark = harness.wire.length;

		const promptPromise = harness.prompt(sessionId, "delegate");
		await harness.waitForNotification((notification) => terminalSubagentUpdate(notification.update));
		const response = await withTimeout(promptPromise, 2_000);

		expect(response.stopReason).toBe("end_turn");
		const terminal = harness.toolCallUpdates("call-subagent").find((update) => update.status === "completed");
		expect(terminal).toBeDefined();
		if (label === "small") {
			expect(contentText(terminal?.content)).toBe(makeReport(bytes));
		} else {
			expect(contentText(terminal?.content)).toContain("[ACP display truncated");
		}
		const exchange = harness.wire.slice(wireMark);
		const terminalIndex = exchange.findIndex((message) => {
			const update = "params" in message ? (message.params as { update?: SessionUpdate }).update : undefined;
			return update !== undefined && terminalSubagentUpdate(update);
		});
		const responseIndex = exchange.findIndex(isResponse);
		expect(terminalIndex).toBeGreaterThanOrEqual(0);
		expect(responseIndex).toBeGreaterThan(terminalIndex);
	});

	it("writes the prompt response without waiting for the client to finish processing the terminal update", async () => {
		let markTerminalSeen: (() => void) | undefined;
		const terminalSeen = new Promise<void>((resolve) => {
			markTerminalSeen = resolve;
		});
		let releaseTerminal: (() => void) | undefined;
		const terminalReleased = new Promise<void>((resolve) => {
			releaseTerminal = resolve;
		});
		harness = await createAcpHarness({
			extensionFactories: [subagentExtension()],
			responses: [
				fauxAssistantMessage([fauxToolCall("subagent", { bytes: SMALL_REPORT_BYTES }, { id: "call-subagent" })]),
				fauxAssistantMessage("parent continued"),
			],
			client: {
				sessionUpdate: async (notification) => {
					if (terminalSubagentUpdate(notification.update)) {
						markTerminalSeen?.();
						await terminalReleased;
					}
				},
			},
		});
		const sessionId = await harness.openSession();
		const wireMark = harness.wire.length;
		const promptPromise = harness.prompt(sessionId, "delegate");
		let clientResolvedPrompt = false;
		void promptPromise.then(() => {
			clientResolvedPrompt = true;
		});

		try {
			await withTimeout(terminalSeen, 2_000);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(harness.wire.slice(wireMark).some(isResponse)).toBe(true);
			// Notification handlers do not block response dispatch in the SDK client.
			expect(clientResolvedPrompt).toBe(true);
		} finally {
			releaseTerminal?.();
		}
		await expect(withTimeout(promptPromise, 2_000)).resolves.toMatchObject({ stopReason: "end_turn" });
	});
});
