/**
 * M6 rebind regression test.
 *
 * PLAN.md's gotcha #5 ("Rebind pattern is mandatory after any
 * newSession/switchSession/fork") warns that forgetting to re-subscribe after
 * an extension-driven session replacement "silently kills all updates" —
 * the prompt that triggers the replacement still resolves (the pi-level
 * `newSession()` call itself works), but every event from the replacement
 * session then goes nowhere, because the translator's `session.subscribe`
 * from the old bind is still pointed at the now-discarded AgentSession.
 *
 * This test drives exactly that scenario through an inline extension command
 * (`/acp-new`, calling `ctx.newSession()`) and asserts three things that a
 * missing rebind would break: the ACP-facing sessionId is unchanged, the
 * underlying pi session really was replaced (proving this is a genuine
 * rebind, not a no-op), and a prompt sent after the replacement still
 * produces `agent_message_chunk` notifications stamped with the original
 * ACP sessionId.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

describe("ACP extension /new keeps the same ACP session id (M6 rebind regression)", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("keeps serving the same ACP sessionId after an extension /new command, and updates keep streaming", async () => {
		harness = await createAcpHarness({
			responses: [fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")],
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-new", {
						description: "Replace the session (rebind regression)",
						handler: async (_args, ctx) => {
							await ctx.newSession();
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();

		const first = await harness.prompt(sessionId, "hello");
		expect(first.stopReason).toBe("end_turn");
		expect(harness.chunkText("agent_message_chunk")).toContain("first reply");

		const handleBefore = harness.agent.agent.sessions.get(sessionId);
		const innerSessionIdBefore = handleBefore?.runtime.session.sessionId;
		// session/new's own contract: the ACP id and the pi session id start out equal.
		expect(innerSessionIdBefore).toBe(sessionId);

		const rebindResponse = await harness.prompt(sessionId, "/acp-new");
		expect(rebindResponse.stopReason).toBe("end_turn");

		// The registry keeps serving the *same* handle object for this ACP
		// sessionId — /new replaces what it points at, not the map entry.
		const handleAfter = harness.agent.agent.sessions.get(sessionId);
		expect(handleAfter).toBe(handleBefore);

		// But the pi session underneath genuinely changed: this is a real
		// replacement, not a no-op the rest of the assertions would pass anyway.
		const innerSessionIdAfter = handleAfter?.runtime.session.sessionId;
		expect(innerSessionIdAfter).toBeDefined();
		expect(innerSessionIdAfter).not.toBe(innerSessionIdBefore);

		// The client only ever knows the original ACP sessionId; prompting it
		// again must still work and still stream, proving the translator was
		// re-subscribed to the replacement session (the mandatory rebind).
		const notificationCountBeforeSecondPrompt = harness.notifications.length;
		const second = await harness.prompt(sessionId, "hello again");
		expect(second.stopReason).toBe("end_turn");

		const chunksAfterRebind = harness.notifications
			.slice(notificationCountBeforeSecondPrompt)
			.filter((notification) => notification.update.sessionUpdate === "agent_message_chunk");
		expect(chunksAfterRebind.length).toBeGreaterThan(0);
		expect(harness.chunkText("agent_message_chunk")).toContain("second reply");

		// Every notification for the whole exchange — before and after the
		// replacement — is still stamped with the one ACP sessionId the client
		// knows about.
		for (const notification of harness.notifications) {
			expect(notification.sessionId).toBe(sessionId);
		}
	}, 20_000);
});
