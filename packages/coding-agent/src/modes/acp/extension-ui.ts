/**
 * Extension UI bridge for ACP mode (M6).
 *
 * ACP's only interactive-decision primitive is `session/request_permission`,
 * which is normally paired with a real tool call the client already saw via
 * `session/update`. Per PLAN.md's "Extension UI bridge" design decision, this
 * module reuses that single primitive for the two extension dialogs ACP can
 * actually support:
 *
 * - `ctx.ui.confirm` -> a yes/no `session/request_permission` with two
 *   options; a `cancelled` outcome (or an outcome the client mis-answers with
 *   an unknown optionId) resolves the caller's default, `false`.
 * - `ctx.ui.select` -> one permission option per choice, keyed by index so
 *   duplicate choice labels stay unambiguous; `cancelled` resolves
 *   `undefined`.
 *
 * The synthetic `toolCall` field each request carries is never announced via
 * `session/update` first (unlike a real tool-call permission prompt) — there
 * is no ACP primitive for a bare confirm/select dialog, so this is the
 * intentional, PLAN.md-directed reuse of the tool-call permission shape for a
 * non-tool-call decision.
 *
 * `ctx.ui.input` / `ctx.ui.editor` have no ACP round-trip equivalent (no
 * text-input primitive is advertised), so they resolve immediately — `input`
 * to `undefined` (there is no "default" to fall back to), `editor` to its
 * `prefill` unchanged — and log a note to stderr so the extension author can
 * see why nothing came back. `notify` also goes to stderr. Everything else
 * (widgets, status, footer/header, theme, editor-component hooks, terminal
 * input) is a no-op, mirroring rpc-mode.ts's headless fallbacks.
 *
 * Project trust stays headless: main.ts already threads `hasUI: false` into
 * `createProjectTrustContext` for every non-interactive AppMode (including
 * "acp"), and `cli/project-trust.ts`'s `notify` already writes untrusted-cwd
 * warnings to stderr for every non-interactive mode. Nothing here re-opens
 * that path — extension-ui.ts only backs the per-session `ExtensionUIContext`
 * bound via `AgentSession.bindExtensions`, which is unrelated to the
 * startup-time project-trust prompt. `--approve` (or a one-time interactive
 * run) remains the way to trust a project headlessly.
 */

import * as crypto from "node:crypto";
import type {
	AgentSideConnection,
	PermissionOption,
	PermissionOptionId,
	RequestPermissionOutcome,
	RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import { theme } from "../interactive/theme/theme.ts";
import { textBlock } from "./content.ts";

export interface AcpExtensionUIContextOptions {
	/** Agent-side connection used to send `session/request_permission`. */
	connection: AgentSideConnection;
	/** ACP session id (stable across rebinds) stamped on every request. */
	sessionId: string;
}

/**
 * Race a `session/request_permission` call against the dialog's `signal`
 * and `timeout`, resolving `defaultValue` the moment either fires without
 * waiting on the client any further (rpc-mode.ts's `createDialogPromise`
 * pattern, adapted to wrap a real SDK request instead of a synthetic pending
 * map). A late client response after the default already won is simply
 * ignored; a rejected request (transport error, disconnect) also resolves
 * the default rather than throwing into extension code.
 */
function requestPermissionWithDialogOptions<T>(
	connection: AgentSideConnection,
	request: RequestPermissionRequest,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	parseOutcome: (outcome: RequestPermissionOutcome) => T,
): Promise<T> {
	if (opts?.signal?.aborted) {
		return Promise.resolve(defaultValue);
	}
	return new Promise<T>((resolve) => {
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			opts?.signal?.removeEventListener("abort", onAbort);
			resolve(value);
		};

		const onAbort = () => finish(defaultValue);
		opts?.signal?.addEventListener("abort", onAbort, { once: true });

		if (opts?.timeout !== undefined) {
			timeoutId = setTimeout(() => finish(defaultValue), opts.timeout);
		}

		connection.requestPermission(request).then(
			(response) => finish(parseOutcome(response.outcome)),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`ACP: session/request_permission failed: ${message}`);
				finish(defaultValue);
			},
		);
	});
}

/**
 * Build a fresh `ExtensionUIContext` for one ACP session bind.
 *
 * Call this on every `bindExtensions` (initial bind and every rebind) rather
 * than caching one instance — the connection and sessionId it closes over
 * don't change across a rebind, but a fresh context per bind keeps this
 * module honest about not accumulating any per-bind state (there is none
 * today, but a future addition should not have to remember to rebuild this).
 */
export function createAcpExtensionUIContext(options: AcpExtensionUIContextOptions): ExtensionUIContext {
	const { connection, sessionId } = options;

	return {
		confirm(title, message, opts) {
			const yesId: PermissionOptionId = "confirm-yes";
			const noId: PermissionOptionId = "confirm-no";
			const request: RequestPermissionRequest = {
				sessionId,
				toolCall: {
					toolCallId: crypto.randomUUID(),
					title,
					kind: "other",
					content: [{ type: "content", content: textBlock(message) }],
				},
				options: [
					{ optionId: yesId, name: "Yes", kind: "allow_once" },
					{ optionId: noId, name: "No", kind: "reject_once" },
				],
			};
			return requestPermissionWithDialogOptions(
				connection,
				request,
				opts,
				false,
				(outcome) => outcome.outcome === "selected" && outcome.optionId === yesId,
			);
		},

		select(title, choices, opts) {
			const options: PermissionOption[] = choices.map((label, index) => ({
				optionId: `option-${index}`,
				name: label,
				kind: "allow_once",
			}));
			const request: RequestPermissionRequest = {
				sessionId,
				toolCall: { toolCallId: crypto.randomUUID(), title, kind: "other" },
				options,
			};
			return requestPermissionWithDialogOptions(connection, request, opts, undefined, (outcome) => {
				if (outcome.outcome !== "selected") return undefined;
				return options.find((option) => option.optionId === outcome.optionId)?.name;
			});
		},

		async input(title, _placeholder, _opts) {
			// ACP advertises no free-text input primitive, so there is nothing to
			// round-trip through the client; resolve immediately with no value.
			console.error(`ACP: extension input dialog "${title}" has no ACP equivalent; resolving with no value`);
			return undefined;
		},

		notify(message, type) {
			console.error(`ACP notify (${type ?? "info"}): ${message}`);
		},

		onTerminalInput() {
			// Raw terminal input has no ACP equivalent.
			return () => {};
		},

		setStatus() {
			// No footer/status-bar concept over ACP.
		},

		setWorkingMessage() {
			// No streaming loader to relabel over ACP.
		},

		setWorkingVisible() {
			// No streaming loader to show/hide over ACP.
		},

		setWorkingIndicator() {
			// No streaming loader to customize over ACP.
		},

		setHiddenThinkingLabel() {
			// No hidden-thinking UI to relabel over ACP (thoughts stream as
			// agent_thought_chunk regardless).
		},

		setWidget() {
			// No widget surface over ACP.
		},

		setFooter() {
			// No footer surface over ACP.
		},

		setHeader() {
			// No header surface over ACP.
		},

		setTitle() {
			// No terminal-title concept over ACP.
		},

		async custom() {
			// Custom interactive components have no ACP equivalent.
			return undefined as never;
		},

		pasteToEditor() {
			// No client-side editor buffer to paste into over ACP.
		},

		setEditorText() {
			// No client-side editor buffer to control over ACP.
		},

		getEditorText() {
			// No client-side editor buffer to read over ACP.
			return "";
		},

		async editor(title, prefill) {
			// ACP advertises no multi-line editor primitive; resolve immediately
			// with the prefill unchanged (i.e. as if the user made no edits).
			console.error(
				`ACP: extension editor dialog "${title}" has no ACP equivalent; resolving with the prefill unchanged`,
			);
			return prefill;
		},

		addAutocompleteProvider() {
			// No client-side editor autocomplete over ACP.
		},

		setEditorComponent() {
			// No client-side editor component over ACP.
		},

		getEditorComponent() {
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme() {
			return undefined;
		},

		setTheme() {
			return { success: false, error: "Theme switching not supported in ACP mode" };
		},

		getToolsExpanded() {
			return false;
		},

		setToolsExpanded() {
			// Tool-output expansion is a TUI rendering concern; no-op over ACP.
		},
	};
}
