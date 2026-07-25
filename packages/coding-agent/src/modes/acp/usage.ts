/**
 * Translates pi's session accounting into the two ACP usage shapes.
 *
 * ACP splits usage across two channels, and clients read them independently
 * (Emacs agent-shell, for example, renders its context indicator from the
 * notification and its token breakdown from the response):
 *
 * - `session/update` with `sessionUpdate: "usage_update"` — how full the
 *   context window is right now, plus cumulative cost.
 * - `session/prompt`'s `usage` field — cumulative token counts for the session.
 *
 * Both are derived from {@link AgentSession.getSessionStats}, whose totals span
 * every entry ever written to the session (including history that compaction
 * dropped), so they reflect what was actually billed rather than what is
 * currently in context.
 */

import type { Usage as AcpUsage, UsageUpdate } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../../core/agent-session.ts";

/** pi prices models in USD; ACP wants an explicit ISO 4217 code. */
const COST_CURRENCY = "USD";

/**
 * Cumulative token counts for `session/prompt`'s `usage` field.
 *
 * pi keeps cache traffic in its own buckets, so `inputTokens` here is
 * uncached input only and cache reads are reported separately — matching how
 * ACP documents the two fields. `totalTokens` is the sum of all four buckets;
 * `thoughtTokens` is a subset of `outputTokens` and is omitted when no
 * provider in the session reported a reasoning breakdown.
 */
export function buildAcpUsage(session: AgentSession): AcpUsage {
	const { tokens } = session.getSessionStats();
	return {
		totalTokens: tokens.total,
		inputTokens: tokens.input,
		outputTokens: tokens.output,
		...(tokens.reasoning > 0 ? { thoughtTokens: tokens.reasoning } : {}),
		cachedReadTokens: tokens.cacheRead,
	};
}

/**
 * Context-window fill and cumulative cost for a `usage_update` notification.
 *
 * `used` is 0 when the context size is unknown — pi reports `tokens: null`
 * between a compaction and the next assistant response, since the only usage
 * it could read describes the pre-compaction context. Reporting 0 rather than
 * suppressing the update keeps cost flowing, and the following turn overwrites
 * it with a real measurement. `size` is 0 when no model is selected or the
 * model declares no context window; clients gate their indicators on it.
 */
export function buildUsageUpdate(session: AgentSession): UsageUpdate {
	const stats = session.getSessionStats();
	return {
		used: stats.contextUsage?.tokens ?? 0,
		size: stats.contextUsage?.contextWindow ?? 0,
		cost: { amount: stats.cost, currency: COST_CURRENCY },
	};
}
