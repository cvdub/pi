/**
 * M1 acceptance tests for ACP mode: mode plumbing + core prompt loop.
 *
 * Everything runs in-process through the harness (see acp-harness.ts): a real
 * SDK ClientSideConnection talks to startAcpAgent over crossed in-memory
 * streams, and the model is a scripted faux provider.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { type Context, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("ACP mode (M1)", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("negotiates initialize and stashes the client capabilities", async () => {
		harness = await createAcpHarness({
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: true },
		});

		const response = await harness.initialize();

		expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(response.agentCapabilities).toEqual({
			loadSession: true,
			promptCapabilities: { image: true, embeddedContext: true },
		});
		expect(response.agentCapabilities?.mcpCapabilities).toBeUndefined();
		expect(response.authMethods).toEqual([]);
		// The SDK normalizes capabilities with schema defaults; assert the
		// client-sent fields survived the stash.
		expect(harness.agent.agent.clientCapabilities).toMatchObject({
			fs: { readTextFile: true, writeTextFile: false },
			terminal: true,
		});
	});

	it("session/new returns the pi session id backed by a session file in the session dir", async () => {
		harness = await createAcpHarness({ responses: [fauxAssistantMessage("hello")] });

		const sessionId = await harness.openSession();

		expect(sessionId).toMatch(UUID_PATTERN);
		const handle = harness.agent.agent.sessions.get(sessionId);
		expect(handle?.runtime.session.sessionId).toBe(sessionId);

		// pi flushes session files once the first assistant message lands.
		await harness.prompt(sessionId, "hi");
		const sessionFiles = readdirSync(harness.sessionDir);
		expect(sessionFiles.some((file) => file.endsWith(`_${sessionId}.jsonl`))).toBe(true);
	});

	it("advertises and changes available pi models through ACP session config", async () => {
		harness = await createAcpHarness({
			models: [
				{ id: "faux-1", name: "Faux One", reasoning: true },
				{ id: "faux-2", name: "Faux Two", reasoning: false },
			],
		});
		await harness.initialize();

		const response = await harness.newSession();
		const modelOption = response.configOptions?.find((option) => option.category === "model");
		const provider = harness.faux.getModel().provider;

		expect(modelOption).toMatchObject({
			id: "model",
			name: "Model",
			category: "model",
			type: "select",
			currentValue: `${provider}/faux-1`,
			options: [
				{ value: `${provider}/faux-1`, name: "Faux One" },
				{ value: `${provider}/faux-2`, name: "Faux Two" },
			],
		});

		const changed = await harness.client.setSessionConfigOption({
			sessionId: response.sessionId,
			configId: "model",
			value: `${provider}/faux-2`,
		});

		expect(harness.agent.agent.sessions.get(response.sessionId)?.runtime.session.model?.id).toBe("faux-2");
		expect(changed.configOptions.find((option) => option.category === "model")).toMatchObject({
			currentValue: `${provider}/faux-2`,
		});
	});

	it("streams agent_message_chunk notifications and resolves with end_turn", async () => {
		const text = "Hello from the faux model. It is a fine day for streaming.";
		harness = await createAcpHarness({ responses: [fauxAssistantMessage(text)] });
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "hi");

		expect(response.stopReason).toBe("end_turn");
		expect(harness.chunkText("agent_message_chunk")).toBe(text);
		expect(harness.updatesOfType("agent_message_chunk").length).toBeGreaterThan(1);
		expect(harness.updatesOfType("agent_thought_chunk")).toHaveLength(0);
		expect(harness.notifications.every((notification) => notification.sessionId === sessionId)).toBe(true);
	});

	it("emits agent_thought_chunk notifications distinct from message chunks", async () => {
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([fauxThinking("Consider the request very carefully."), fauxText("The answer is 42.")]),
			],
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "think about it");

		expect(response.stopReason).toBe("end_turn");
		expect(harness.chunkText("agent_thought_chunk")).toBe("Consider the request very carefully.");
		expect(harness.chunkText("agent_message_chunk")).toBe("The answer is 42.");
	});

	it("session/cancel mid-stream resolves the prompt with cancelled after final updates flush", async () => {
		harness = await createAcpHarness({
			tokensPerSecond: 30,
			responses: [fauxAssistantMessage("stream ".repeat(120))],
		});
		const sessionId = await harness.openSession();

		const promptPromise = harness.prompt(sessionId, "go");
		await harness.waitForNotification((notification) => notification.update.sessionUpdate === "agent_message_chunk");
		await harness.cancel(sessionId);

		const response = await promptPromise;
		expect(response.stopReason).toBe("cancelled");

		// All updates were flushed before the prompt resolved: nothing trails in.
		const seen = harness.notifications.length;
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(harness.notifications.length).toBe(seen);
	});

	it("a second prompt mid-turn steers and both prompts resolve at the next settle", async () => {
		let steeredContext: Context | undefined;
		harness = await createAcpHarness({
			tokensPerSecond: 30,
			responses: [
				fauxAssistantMessage("stream ".repeat(120)),
				(context) => {
					steeredContext = context;
					return fauxAssistantMessage("Steered reply.");
				},
			],
		});
		const sessionId = await harness.openSession();

		const firstPromise = harness.prompt(sessionId, "first prompt");
		await harness.waitForNotification((notification) => notification.update.sessionUpdate === "agent_message_chunk");
		const secondPromise = harness.prompt(sessionId, "please steer to the second topic");

		const [firstResponse, secondResponse] = await Promise.all([firstPromise, secondPromise]);
		expect(firstResponse.stopReason).toBe("end_turn");
		expect(secondResponse.stopReason).toBe("end_turn");
		expect(harness.faux.state.callCount).toBe(2);
		expect(JSON.stringify(steeredContext?.messages ?? [])).toContain("please steer to the second topic");
		expect(harness.chunkText("agent_message_chunk")).toContain("Steered reply.");
	});

	it("rejects prompts for unknown session ids with a JSON-RPC error", async () => {
		harness = await createAcpHarness();
		await harness.initialize();

		await expect(harness.prompt("00000000-0000-0000-0000-000000000000", "hi")).rejects.toMatchObject({
			code: -32602,
		});
	});

	it("threads injected toolsOptions through per-session runtimes into tool execution", async () => {
		const readPaths: string[] = [];
		let followUpContext: Context | undefined;
		harness = await createAcpHarness({
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path: "virtual.txt" })]),
				(context) => {
					followUpContext = context;
					return fauxAssistantMessage("read complete");
				},
			],
			createToolsOptions: () => ({
				read: {
					operations: {
						readFile: async (absolutePath: string) => {
							readPaths.push(absolutePath);
							return Buffer.from("SENTINEL-DELEGATED-CONTENT\n");
						},
						access: async () => {},
					},
				},
			}),
		});
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "read the file");

		expect(response.stopReason).toBe("end_turn");
		expect(readPaths).toEqual([join(harness.cwd, "virtual.txt")]);
		expect(JSON.stringify(followUpContext?.messages ?? [])).toContain("SENTINEL-DELEGATED-CONTENT");
	});
});

describe("ACP CLI plumbing (M1)", () => {
	it("parseArgs accepts --mode acp", () => {
		expect(parseArgs(["--mode", "acp"]).mode).toBe("acp");
	});

	it("parseArgs still drops unknown modes", () => {
		expect(parseArgs(["--mode", "bogus"]).mode).toBeUndefined();
	});
});
