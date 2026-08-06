import { describe, expect, it } from "vitest";
import { supportsFastMode } from "../src/core/fast-mode.ts";

describe("supportsFastMode", () => {
	it("supports GPT models from the OpenAI Codex provider", () => {
		expect(supportsFastMode({ provider: "openai-codex", id: "gpt-5.4" })).toBe(true);
		expect(supportsFastMode({ provider: "openai-codex", id: "gpt-5.3-codex" })).toBe(true);
	});

	it("rejects non-Codex providers and non-GPT models", () => {
		expect(supportsFastMode({ provider: "openai", id: "gpt-5.4" })).toBe(false);
		expect(supportsFastMode({ provider: "openai-codex", id: "o3" })).toBe(false);
		expect(supportsFastMode(undefined)).toBe(false);
	});
});
