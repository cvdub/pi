/**
 * Usage reporting: the `usage` field on `session/prompt` responses and the
 * `usage_update` notifications that carry context fill and cost.
 *
 * Clients read the two independently — Emacs agent-shell renders its context
 * indicator from the notification and its token breakdown from the response —
 * so both are asserted separately here.
 *
 * The faux provider computes real input/output/cache token counts from the
 * prompt and response text, but always prices them at zero, so cost assertions
 * check the envelope (currency, presence) rather than an amount.
 */

import type { AnyMessage, SessionNotification, UsageUpdate } from "@agentclientprotocol/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

/** The faux provider's default context window (see FauxModelDefinition). */
const FAUX_CONTEXT_WINDOW = 128_000;

type UsageUpdateNotification = UsageUpdate & { sessionUpdate: "usage_update" };

function usageUpdates(harness: AcpHarness): UsageUpdateNotification[] {
	return harness.updatesOfType("usage_update");
}

function isResponse(message: AnyMessage): boolean {
	return "id" in message && ("result" in message || "error" in message);
}

function isUsageUpdate(message: AnyMessage): boolean {
	const params = (message as { params?: { update?: SessionNotification["update"] } }).params;
	return params?.update?.sessionUpdate === "usage_update";
}

describe("ACP usage reporting", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("returns cumulative token usage on the session/prompt response", async () => {
		harness = await createAcpHarness({ responses: [fauxAssistantMessage("hello there")] });
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "count my tokens");

		const usage = response.usage;
		expect(usage).toBeDefined();
		expect(usage?.outputTokens).toBeGreaterThan(0);
		// pi buckets cache traffic separately from uncached input, so totalTokens
		// is the sum of all four buckets rather than input + output.
		expect(usage?.totalTokens).toBeGreaterThan(0);
		expect(usage?.totalTokens).toBeGreaterThanOrEqual((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0));
		expect(usage?.cachedReadTokens).toBeGreaterThanOrEqual(0);
	});

	it("accumulates token usage across turns", async () => {
		harness = await createAcpHarness({
			responses: [fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")],
		});
		const sessionId = await harness.openSession();

		const first = await harness.prompt(sessionId, "one");
		const second = await harness.prompt(sessionId, "two");

		expect(second.usage?.totalTokens).toBeGreaterThan(first.usage?.totalTokens ?? 0);
		expect(second.usage?.outputTokens).toBeGreaterThan(first.usage?.outputTokens ?? 0);
	});

	it("omits thoughtTokens when no provider reported a reasoning breakdown", async () => {
		harness = await createAcpHarness({ responses: [fauxAssistantMessage("no thinking here")] });
		const sessionId = await harness.openSession();

		const response = await harness.prompt(sessionId, "hi");

		expect(response.usage?.thoughtTokens).toBeUndefined();
	});

	it("emits a usage_update carrying context fill and cost when the turn settles", async () => {
		harness = await createAcpHarness({ responses: [fauxAssistantMessage("hello")] });
		const sessionId = await harness.openSession();

		await harness.prompt(sessionId, "hi");

		const updates = usageUpdates(harness);
		expect(updates).toHaveLength(1);
		expect(updates[0].size).toBe(FAUX_CONTEXT_WINDOW);
		expect(updates[0].used).toBeGreaterThan(0);
		expect(updates[0].used).toBeLessThan(FAUX_CONTEXT_WINDOW);
		expect(updates[0].cost).toMatchObject({ currency: "USD" });
		expect(typeof updates[0].cost?.amount).toBe("number");
	});

	it("puts the usage_update on the wire before the session/prompt response", async () => {
		harness = await createAcpHarness({ responses: [fauxAssistantMessage("hello")] });
		const sessionId = await harness.openSession();

		const wireMark = harness.wire.length;
		await harness.prompt(sessionId, "hi");

		// The settle queues the usage_update ahead of the flush it waits on, so
		// a client that renders usage on notification has it by the time the
		// response resolves.
		const exchange = harness.wire.slice(wireMark);
		const usageIndex = exchange.findIndex(isUsageUpdate);
		const responseIndex = exchange.findIndex(isResponse);
		expect(usageIndex).toBeGreaterThanOrEqual(0);
		expect(responseIndex).toBeGreaterThan(usageIndex);

		// Wire shape, not just the SDK-typed view: `used`/`size`/`cost` sit
		// directly alongside `sessionUpdate` on `params.update`. Clients read
		// them from exactly there, so a nested payload would parse as absent.
		expect(JSON.parse(JSON.stringify(exchange[usageIndex]))).toMatchObject({
			method: "session/update",
			params: {
				sessionId,
				update: {
					sessionUpdate: "usage_update",
					used: expect.any(Number),
					size: FAUX_CONTEXT_WINDOW,
					cost: { amount: expect.any(Number), currency: "USD" },
				},
			},
		});
	});

	// A turn settles twice (agent_settled, then session.prompt() resolving), so
	// this pins the dedupe: one update per turn, not one per settle.
	it("reports one usage_update per turn", async () => {
		harness = await createAcpHarness({
			responses: [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
		});
		const sessionId = await harness.openSession();

		await harness.prompt(sessionId, "one");
		await harness.prompt(sessionId, "two");

		const updates = usageUpdates(harness);
		expect(updates).toHaveLength(2);
		expect(updates.every((update) => update.used > 0 && update.size === FAUX_CONTEXT_WINDOW)).toBe(true);
	});
});
