/**
 * fs delegation for ACP mode (M3).
 *
 * When the client advertises `clientCapabilities.fs`, text reads and writes
 * are delegated to `fs/read_text_file` / `fs/write_text_file` so the agent
 * sees the editor's live (possibly unsaved) buffer content instead of what is
 * on disk. `readTextFile` and `writeTextFile` are gated independently per
 * PLAN.md: a client may advertise one without the other.
 *
 * Kept local regardless of capabilities:
 * - image/binary sniffing and the read path for images (`fs/read_text_file`
 *   is a text-only ACP method; the point of delegation is unsaved editor
 *   buffers of text files, not binary content)
 * - `mkdir` (ACP has no mkdir equivalent; the agent and client share a
 *   filesystem over stdio, so parent directories are always created locally)
 *
 * A client that throws `RequestError` for a delegated call (fails or
 * declines it) falls back to the equivalent local operation instead of
 * failing the tool.
 */

import { constants } from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { EditOperations, ReadOperations, ToolsOptions, WriteOperations } from "../../core/tools/index.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { AcpToolsOptionsContext } from "./types.ts";

/** Delegate a text read to `fs/read_text_file`, falling back to disk on `RequestError`. */
async function delegatedReadTextFile(
	connection: AgentSideConnection,
	sessionId: string,
	absolutePath: string,
): Promise<Buffer> {
	try {
		const response = await connection.readTextFile({ sessionId, path: absolutePath });
		return Buffer.from(response.content, "utf-8");
	} catch (error) {
		if (error instanceof RequestError) {
			return fsReadFile(absolutePath);
		}
		throw error;
	}
}

/** Delegate a text write to `fs/write_text_file`, falling back to disk on `RequestError`. */
async function delegatedWriteTextFile(
	connection: AgentSideConnection,
	sessionId: string,
	absolutePath: string,
	content: string,
): Promise<void> {
	try {
		await connection.writeTextFile({ sessionId, path: absolutePath, content });
	} catch (error) {
		if (error instanceof RequestError) {
			await fsWriteFile(absolutePath, content, "utf-8");
			return;
		}
		throw error;
	}
}

/**
 * ReadOperations for the `read` tool: delegates text reads to the client
 * when it advertises `fs.readTextFile`; image/binary reads always bypass
 * delegation and go straight to disk.
 */
export function createAcpReadOperations(context: AcpToolsOptionsContext): ReadOperations {
	const canDelegateReads = context.clientCaps.current?.fs?.readTextFile === true;
	return {
		access: (absolutePath) => fsAccess(absolutePath, constants.R_OK),
		detectImageMimeType: detectSupportedImageMimeTypeFromFile,
		readFile: async (absolutePath) => {
			if (!canDelegateReads) {
				return fsReadFile(absolutePath);
			}
			const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
			if (mimeType) {
				// Images/binaries are always read locally.
				return fsReadFile(absolutePath);
			}
			return delegatedReadTextFile(context.connection, context.sessionId, absolutePath);
		},
	};
}

/**
 * EditOperations for the `edit` tool: the current content is read via the
 * same delegated-read path as the `read` tool (so edits are computed against
 * the client's unsaved buffer), and the result is written back the same way.
 */
export function createAcpEditOperations(context: AcpToolsOptionsContext): EditOperations {
	const canDelegateReads = context.clientCaps.current?.fs?.readTextFile === true;
	const canDelegateWrites = context.clientCaps.current?.fs?.writeTextFile === true;
	return {
		access: (absolutePath) => fsAccess(absolutePath, constants.R_OK | constants.W_OK),
		readFile: (absolutePath) =>
			canDelegateReads
				? delegatedReadTextFile(context.connection, context.sessionId, absolutePath)
				: fsReadFile(absolutePath),
		writeFile: (absolutePath, content) =>
			canDelegateWrites
				? delegatedWriteTextFile(context.connection, context.sessionId, absolutePath, content)
				: fsWriteFile(absolutePath, content, "utf-8"),
	};
}

/**
 * WriteOperations for the `write` tool: parent directories are always
 * created locally (no ACP mkdir), and the file content itself is delegated
 * when the client advertises `fs.writeTextFile`.
 */
export function createAcpWriteOperations(context: AcpToolsOptionsContext): WriteOperations {
	const canDelegateWrites = context.clientCaps.current?.fs?.writeTextFile === true;
	return {
		mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
		writeFile: (absolutePath, content) =>
			canDelegateWrites
				? delegatedWriteTextFile(context.connection, context.sessionId, absolutePath, content)
				: fsWriteFile(absolutePath, content, "utf-8"),
	};
}

/**
 * Builds the `read`/`edit`/`write` fragment of `ToolsOptions` for fs
 * delegation, gated on `clientCapabilities.fs`. Pass directly as
 * `AcpAgentDeps.createToolsOptions` for fs-only delegation, or combine with
 * other tool options (e.g. terminal delegation's `bash`) at the call site.
 */
export function createAcpFsToolsOptions(context: AcpToolsOptionsContext): ToolsOptions {
	return {
		read: { operations: createAcpReadOperations(context) },
		edit: { operations: createAcpEditOperations(context) },
		write: { operations: createAcpWriteOperations(context) },
	};
}
