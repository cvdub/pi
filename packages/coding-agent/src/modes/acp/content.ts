/**
 * Conversion between ACP ContentBlocks and pi's text/image prompt content.
 *
 * Used by the prompt path (ACP -> pi) and shared with M5's history replay
 * (pi -> ACP) for the outbound chunk helpers.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Prompt content in pi's shape: one text body plus image attachments. */
export interface PiPromptContent {
	text: string;
	images: ImageContent[];
}

/** Build an ACP text content block (outbound chunks, replayed history). */
export function textBlock(text: string): ContentBlock {
	return { type: "text", text };
}

function formatEmbeddedResource(uri: string, text: string): string {
	return `<context ref="${uri}">\n${text}\n</context>`;
}

/**
 * Flatten an ACP prompt (ContentBlock[]) into pi prompt content.
 *
 * - `text` blocks become the prompt body (joined with blank lines)
 * - `image` blocks become pi image attachments
 * - `resource_link` blocks are referenced by URI
 * - embedded `resource` blocks with text are inlined as context sections
 * - `audio` blocks are unsupported and skipped (not advertised in
 *   promptCapabilities)
 */
export function promptBlocksToPi(blocks: ContentBlock[]): PiPromptContent {
	const textParts: string[] = [];
	const images: ImageContent[] = [];

	for (const block of blocks) {
		switch (block.type) {
			case "text":
				textParts.push(block.text);
				break;
			case "image":
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				textParts.push(block.uri);
				break;
			case "resource": {
				const resource = block.resource;
				if ("text" in resource) {
					textParts.push(formatEmbeddedResource(resource.uri, resource.text));
				}
				break;
			}
			case "audio":
				break;
		}
	}

	return { text: textParts.join("\n\n"), images };
}
