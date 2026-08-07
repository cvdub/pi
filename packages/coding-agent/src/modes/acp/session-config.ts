/**
 * ACP session configuration projected from a live pi AgentSession.
 *
 * Model values use canonical `provider/model-id` references so equal model IDs
 * from different providers remain distinct on the wire.
 */

import type { SessionConfigOption, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";

const MODEL_CONFIG_ID = "model";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
export const FAST_MODE_CONFIG_ID = "fast_mode";

function modelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function thinkingLevelName(level: ThinkingLevel): string {
	return `Thinking: ${level}`;
}

/**
 * Fast mode is a persisted global setting that only takes effect on models
 * accepting the priority service tier, so it stays visible on every model and
 * says in its description when the current model ignores it.
 */
function fastModeDescription(session: AgentSession): string {
	if (session.supportsFastMode()) {
		return "Priority service tier for faster responses.";
	}
	const model = session.model;
	const modelRef = model ? modelReference(model) : "the current model";
	return `Priority service tier for faster responses (inactive for ${modelRef}).`;
}

/**
 * Build the complete ACP configuration state for the current pi session.
 *
 * Pi has no permission/sandbox modes and no longer aliases the ACP mode
 * controls to its thinking level, so the thinking level is exposed exactly
 * once, as the `thought_level` config option.
 */
export async function buildSessionConfigOptions(session: AgentSession): Promise<SessionConfigOption[]> {
	const currentModel = session.model;
	const options: SessionConfigOption[] = [];

	if (currentModel) {
		const availableModels = [...(await session.modelRuntime.getAvailable())];
		if (!availableModels.some((model) => modelReference(model) === modelReference(currentModel))) {
			availableModels.unshift(currentModel);
		}

		options.push({
			id: MODEL_CONFIG_ID,
			name: "Model",
			description: "Model used for this session.",
			category: "model",
			type: "select",
			currentValue: modelReference(currentModel),
			options: availableModels.map((model) => ({
				value: modelReference(model),
				name: model.name ?? model.id,
				description: model.provider,
			})),
		});
	}

	options.push({
		id: THOUGHT_LEVEL_CONFIG_ID,
		name: "Thinking",
		description: "Reasoning effort for this session.",
		category: "thought_level",
		type: "select",
		currentValue: session.thinkingLevel,
		options: session.getAvailableThinkingLevels().map((level) => ({
			value: level,
			name: thinkingLevelName(level),
			description: null,
		})),
	});

	// A `boolean` option would model this better, but clients commonly only
	// offer `select` options in their config picker, so an on/off select is
	// what actually reaches the user.
	options.push({
		id: FAST_MODE_CONFIG_ID,
		name: "Fast mode",
		description: fastModeDescription(session),
		category: "_fast_mode",
		type: "select",
		currentValue: session.fastMode ? "on" : "off",
		options: [
			{ value: "on", name: "Fast mode: on", description: null },
			{ value: "off", name: "Fast mode: off", description: null },
		],
	});

	return options;
}

/** Apply one ACP configuration change and return the complete updated state. */
export async function setSessionConfigOption(
	session: AgentSession,
	params: SetSessionConfigOptionRequest,
): Promise<SessionConfigOption[]> {
	if (typeof params.value !== "string") {
		throw RequestError.invalidParams(params, `Session config option "${params.configId}" requires a string value`);
	}

	if (params.configId === MODEL_CONFIG_ID) {
		const availableModels = await session.modelRuntime.getAvailable();
		const model = availableModels.find((candidate) => modelReference(candidate) === params.value);
		if (!model) {
			throw RequestError.invalidParams(params, `Unknown or unavailable model: ${params.value}`);
		}

		await session.setModel(model);
		return buildSessionConfigOptions(session);
	}

	if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
		const thinkingLevel = session.getAvailableThinkingLevels().find((level) => level === params.value);
		if (!thinkingLevel) {
			throw RequestError.invalidParams(params, `Unknown or unavailable thinking level: ${params.value}`);
		}

		session.setThinkingLevel(thinkingLevel);
		return buildSessionConfigOptions(session);
	}

	if (params.configId === FAST_MODE_CONFIG_ID) {
		if (params.value !== "on" && params.value !== "off") {
			throw RequestError.invalidParams(params, `Fast mode expects "on" or "off", got: ${params.value}`);
		}

		session.setFastMode(params.value === "on");
		return buildSessionConfigOptions(session);
	}

	throw RequestError.invalidParams(params, `Unknown session config option: ${params.configId}`);
}
