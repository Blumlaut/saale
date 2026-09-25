/**
 * Context-window occupancy for an agent session.
 *
 * `session.getContextUsage()` is Pi's own accounting — the same number the TUI
 * footer shows — and it is the only correct source for "how full is the
 * context". Summing per-message `usage` cannot stand in for it:
 *
 *  - Providers report prompt-cache hits separately from `input` (`cacheRead`),
 *    so a warm cache makes an input+output sum look nearly empty even though
 *    the whole conversation is being re-sent.
 *  - `input` counts are cumulative across turns, while context size is the
 *    size of the *last* request — the two diverge with every turn.
 *  - Providers that report no usage at all (many OpenAI-compatible endpoints)
 *    leave every sum at zero, while Pi falls back to estimating the projected
 *    transcript (~4 chars/token) so the indicator still moves.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Context occupancy as reported by Pi. */
export interface ContextUsage {
  /** Tokens Pi expects to send on the next request, or null when unknown (e.g. right after a compaction, until the next response). */
  tokens: number | null;
  /** The model's context window in tokens (0 when the model doesn't declare one). */
  contextWindow: number;
}

/** Read Pi's context occupancy for a session. */
export function readContextUsage(session: AgentSession): ContextUsage {
  const usage = session.getContextUsage();
  return {
    tokens: usage?.tokens ?? null,
    contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
  };
}
