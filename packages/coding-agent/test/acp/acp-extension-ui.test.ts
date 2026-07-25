/**
 * M6 acceptance tests for ACP mode: the extension UI bridge.
 *
 * `ctx.ui.confirm`/`ctx.ui.select` round-trip through a real
 * `session/request_permission` call to the harness's SDK client
 * (`extension-ui.ts`); `ctx.ui.input` has no ACP equivalent and must resolve
 * without ever contacting the client. All of these are exercised through
 * inline extension commands (`extensionFactories`) invoked as `/name` prompt
 * text, exactly as a real ACP client would invoke them.
 */

import type { PermissionOption, RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AcpHarness, createAcpHarness } from "./acp-harness.ts";

/** Sentinel distinct from `undefined` so "never assigned" is distinguishable from "resolved to undefined". */
const UNSET = Symbol("unset");

describe("ACP extension UI bridge (M6)", () => {
	let harness: AcpHarness | undefined;

	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("ctx.ui.confirm performs a session/request_permission round trip and resolves true for the affirmative option", async () => {
		let confirmResult: boolean | undefined;
		let seenRequest: RequestPermissionRequest | undefined;
		harness = await createAcpHarness({
			client: {
				requestPermission: async (params) => {
					seenRequest = params;
					const yes = params.options.find((option) => option.kind === "allow_once");
					if (!yes) throw new Error("expected an allow_once option");
					return { outcome: { outcome: "selected", optionId: yes.optionId } };
				},
			},
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-confirm-yes", {
						description: "confirm yes",
						handler: async (_args, ctx) => {
							confirmResult = await ctx.ui.confirm("Proceed?", "Are you sure you want to proceed?");
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-confirm-yes");

		expect(confirmResult).toBe(true);
		expect(seenRequest?.sessionId).toBe(sessionId);
		expect(seenRequest?.options).toHaveLength(2);
		expect(seenRequest?.toolCall.title).toBe("Proceed?");
	});

	it("resolves ctx.ui.confirm to false when the client cancels the permission request", async () => {
		let confirmResult: boolean | undefined;
		harness = await createAcpHarness({
			// The harness's default requestPermission always answers `cancelled`.
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-confirm-cancel", {
						description: "confirm cancel",
						handler: async (_args, ctx) => {
							confirmResult = await ctx.ui.confirm("Proceed?", "message");
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-confirm-cancel");

		expect(confirmResult).toBe(false);
	});

	it("ctx.ui.select maps each choice to a distinct permission option and resolves to the chosen label", async () => {
		let selectResult: string | undefined;
		let seenOptions: PermissionOption[] | undefined;
		harness = await createAcpHarness({
			client: {
				requestPermission: async (params) => {
					seenOptions = params.options;
					const beta = params.options.find((option) => option.name === "beta");
					if (!beta) throw new Error("expected a 'beta' option");
					return { outcome: { outcome: "selected", optionId: beta.optionId } };
				},
			},
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-select", {
						description: "select test",
						handler: async (_args, ctx) => {
							selectResult = await ctx.ui.select("Pick one", ["alpha", "beta", "gamma"]);
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-select");

		expect(selectResult).toBe("beta");
		expect(seenOptions?.map((option) => option.name)).toEqual(["alpha", "beta", "gamma"]);
		const optionIds = seenOptions?.map((option) => option.optionId) ?? [];
		expect(new Set(optionIds).size).toBe(optionIds.length);
	});

	it("resolves ctx.ui.select to undefined when the client cancels the permission request", async () => {
		let selectResult: string | undefined | typeof UNSET = UNSET;
		harness = await createAcpHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-select-cancel", {
						description: "select cancel",
						handler: async (_args, ctx) => {
							selectResult = await ctx.ui.select("Pick one", ["alpha", "beta"]);
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-select-cancel");

		expect(selectResult).toBeUndefined();
	});

	it("ctx.ui.input resolves without a session/request_permission round trip", async () => {
		const requestPermission = vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } }));
		let inputResult: string | undefined | typeof UNSET = UNSET;
		harness = await createAcpHarness({
			client: { requestPermission },
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-input", {
						description: "input test",
						handler: async (_args, ctx) => {
							inputResult = await ctx.ui.input("Name?", "placeholder");
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-input");

		expect(inputResult).toBeUndefined();
		expect(requestPermission).not.toHaveBeenCalled();
	});

	it("ctx.ui.editor resolves the prefill unchanged without a round trip", async () => {
		const requestPermission = vi.fn(async () => ({ outcome: { outcome: "cancelled" as const } }));
		let editorResult: string | undefined | typeof UNSET = UNSET;
		harness = await createAcpHarness({
			client: { requestPermission },
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-editor", {
						description: "editor test",
						handler: async (_args, ctx) => {
							editorResult = await ctx.ui.editor("Edit", "original content");
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-editor");

		expect(editorResult).toBe("original content");
		expect(requestPermission).not.toHaveBeenCalled();
	});

	it("resolves confirm's default immediately when the dialog signal is already aborted, without contacting the client", async () => {
		const requestPermission = vi.fn(async () => ({
			outcome: { outcome: "selected" as const, optionId: "confirm-yes" },
		}));
		const controller = new AbortController();
		controller.abort();
		let confirmResult: boolean | undefined;
		harness = await createAcpHarness({
			client: { requestPermission },
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-confirm-aborted", {
						description: "confirm aborted",
						handler: async (_args, ctx) => {
							confirmResult = await ctx.ui.confirm("t", "m", { signal: controller.signal });
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-confirm-aborted");

		expect(confirmResult).toBe(false);
		expect(requestPermission).not.toHaveBeenCalled();
	});

	it("resolves confirm's default once the dialog timeout elapses, without waiting on a client that never responds", async () => {
		const requestPermission = vi.fn(() => new Promise<never>(() => {}));
		let confirmResult: boolean | undefined;
		harness = await createAcpHarness({
			client: { requestPermission },
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-confirm-timeout", {
						description: "confirm timeout",
						handler: async (_args, ctx) => {
							confirmResult = await ctx.ui.confirm("t", "m", { timeout: 20 });
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-confirm-timeout");

		// The request was sent (unlike the already-aborted case above) but its
		// result is never awaited past the timeout.
		expect(confirmResult).toBe(false);
		expect(requestPermission).toHaveBeenCalledTimes(1);
	});

	it('exposes ctx.mode as "acp" to extensions', async () => {
		let observedMode: string | undefined;
		harness = await createAcpHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("acp-mode", {
						description: "mode test",
						handler: async (_args, ctx) => {
							observedMode = ctx.mode;
						},
					});
				},
			],
		});

		const sessionId = await harness.openSession();
		await harness.prompt(sessionId, "/acp-mode");

		expect(observedMode).toBe("acp");
	});
});
