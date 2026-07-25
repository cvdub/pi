/**
 * ACP session configuration projected from a live pi AgentSession.
 *
 * Model values use canonical `provider/model-id` references so equal model IDs
 * from different providers remain distinct on the wire.
 */

import type { SessionConfigOption, SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";

const MODEL_CONFIG_ID = "model";

function modelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** Build the complete ACP configuration state for the current pi session. */
export async function buildSessionConfigOptions(session: AgentSession): Promise<SessionConfigOption[]> {
	const currentModel = session.model;
	if (!currentModel) {
		return [];
	}

	const availableModels = [...(await session.modelRuntime.getAvailable())];
	if (!availableModels.some((model) => modelReference(model) === modelReference(currentModel))) {
		availableModels.unshift(currentModel);
	}

	return [
		{
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
		},
	];
}

/** Apply one ACP configuration change and return the complete updated state. */
export async function setSessionConfigOption(
	session: AgentSession,
	params: SetSessionConfigOptionRequest,
): Promise<SessionConfigOption[]> {
	if (params.configId !== MODEL_CONFIG_ID) {
		throw RequestError.invalidParams(params, `Unknown session config option: ${params.configId}`);
	}
	if (typeof params.value !== "string") {
		throw RequestError.invalidParams(params, `Session config option "${MODEL_CONFIG_ID}" requires a string value`);
	}

	const availableModels = await session.modelRuntime.getAvailable();
	const model = availableModels.find((candidate) => modelReference(candidate) === params.value);
	if (!model) {
		throw RequestError.invalidParams(params, `Unknown or unavailable model: ${params.value}`);
	}

	await session.setModel(model);
	return buildSessionConfigOptions(session);
}
