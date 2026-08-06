export interface FastModeModel {
	provider: string;
	id: string;
}

export function supportsFastMode(model: FastModeModel | undefined): boolean {
	return model?.provider === "openai-codex" && model.id.startsWith("gpt-");
}
