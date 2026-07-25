/**
 * ACP session configuration projected from a live pi AgentSession.
 *
 * Model values use canonical `provider/model-id` references so equal model IDs
 * from different providers remain distinct on the wire.
 */

import type { SessionConfigOption, SessionModeState, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";

const MODEL_CONFIG_ID = "model";
export const MODE_CONFIG_ID = "mode";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const LEGACY_SESSION_MODE_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

function modelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function thinkingLevelName(level: ThinkingLevel): string {
	return `Thinking: ${level}`;
}

/**
 * Build legacy ACP session modes for clients that predate thought-level config
 * options. Pi has no permission/sandbox modes, so its established ACP adapter
 * maps this legacy control to the session thinking level.
 */
export function buildSessionModes(session: AgentSession): SessionModeState {
	return {
		currentModeId: session.thinkingLevel,
		availableModes: LEGACY_SESSION_MODE_LEVELS.map((level) => ({
			id: level,
			name: thinkingLevelName(level),
			description: "Reasoning effort for this session.",
		})),
	};
}

/** Resolve a mode advertised through the stable legacy ACP mode list. */
export function legacySessionModeLevel(modeId: string): ThinkingLevel | undefined {
	return LEGACY_SESSION_MODE_LEVELS.find((level) => level === modeId);
}

/** Build the complete ACP configuration state for the current pi session. */
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

	const thinkingOptions = session.getAvailableThinkingLevels().map((level) => ({
		value: level,
		name: thinkingLevelName(level),
		description: null,
	}));
	options.push(
		{
			id: MODE_CONFIG_ID,
			name: "Session mode",
			description: "Compatibility control for the Pi thinking level.",
			category: "mode",
			type: "select",
			currentValue: session.thinkingLevel,
			options: thinkingOptions,
		},
		{
			id: THOUGHT_LEVEL_CONFIG_ID,
			name: "Thinking",
			description: "Reasoning effort for this session.",
			category: "thought_level",
			type: "select",
			currentValue: session.thinkingLevel,
			options: thinkingOptions,
		},
	);

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

	if (params.configId === MODE_CONFIG_ID || params.configId === THOUGHT_LEVEL_CONFIG_ID) {
		const thinkingLevel = session.getAvailableThinkingLevels().find((level) => level === params.value);
		if (!thinkingLevel) {
			throw RequestError.invalidParams(params, `Unknown or unavailable thinking level: ${params.value}`);
		}

		session.setThinkingLevel(thinkingLevel);
		return buildSessionConfigOptions(session);
	}

	throw RequestError.invalidParams(params, `Unknown session config option: ${params.configId}`);
}
