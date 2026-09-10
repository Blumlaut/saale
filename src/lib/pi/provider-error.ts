/**
 * Provider error surfacing.
 *
 * A provider failure (bad request, rate limit, network drop) does NOT throw in
 * Pi — it ends the assistant message with `stopReason: "error"` and an
 * `errorMessage` string. Without handling, a failed run persists an empty
 * assistant message and the user is left staring at a chat that never answered.
 *
 * `extractProviderError` pulls that string out of an SDK message (server side);
 * `formatProviderError` makes it readable for the UI (client side). The raw
 * string is what gets persisted, so the presentation can improve without a
 * backfill.
 */

/** Fallback when the provider reports a failure without a message. */
export const UNKNOWN_PROVIDER_ERROR = "The provider returned an error";

/** The subset of an assistant message needed to detect a provider failure. */
export interface ProviderErrorSource {
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Extract the provider error from an SDK assistant message.
 *
 * Only `stopReason: "error"` counts — `"aborted"` is Pi's own marker for a
 * run it cancelled (e.g. an abort during retry backoff) and carries no provider
 * fault. Note that a request cancelled mid-stream is NOT reported that way: it
 * arrives as `"error"` with a transport message like `"terminated"`, which is
 * why callers must only surface errors for terminal runs — see
 * `finalizeProvisionalTurn` in the session event tracker.
 *
 * @returns The provider error text, or null when the turn did not fail.
 */
export function extractProviderError(
  message: ProviderErrorSource | null | undefined,
): string | null {
  if (!message || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || UNKNOWN_PROVIDER_ERROR;
}

/** A parsed provider error: HTTP status (when reported) plus a readable message. */
export interface FormattedProviderError {
  /** HTTP status, when the error text starts with one (Pi prefixes `400: {...}`). */
  status?: number;
  /** Human-readable message. */
  message: string;
  /** Whether `message` is a shortening of the original text. */
  shortened: boolean;
}

/**
 * Keys that carry the human-readable message in provider error bodies
 * (OpenAI, Anthropic, and the common gateways).
 */
const MESSAGE_KEYS = ["message", "detail", "error_description"];

/**
 * Parse a JSON error body. Returns null when the text isn't JSON — the normal
 * outcome for plain-text provider errors (`fetch failed`), not a failure.
 */
function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Recursively look for the first message-ish string in a parsed error body. */
function findMessage(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  // Nested shapes: `{ error: { message } }`, `{ error: "..." }`.
  for (const key of ["error", "errors", "body"]) {
    const nested = record[key];
    if (typeof nested === "string" && nested.trim()) return nested.trim();
    const found = findMessage(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Turn a raw provider error into something a user can act on.
 *
 * Pi reports errors as `<status>: <body>` (e.g.
 * `400: {"message":"Invalid max_tokens value"}`). Raw JSON in a chat bubble is
 * noise, so the status is split off and the body's message extracted. Anything
 * unrecognized is shown verbatim — never hidden.
 *
 * @example
 * formatProviderError('400: {"message":"Invalid max_tokens value"}')
 * // { status: 400, message: "Invalid max_tokens value", shortened: true }
 * formatProviderError("fetch failed")
 * // { message: "fetch failed", shortened: false }
 */
export function formatProviderError(raw: string): FormattedProviderError {
  const text = raw.trim();

  // `<status>: <body>` — Pi's prefix for HTTP failures (may contain a JSON body
  // with colons of its own, so split only on the first one).
  const statusMatch = /^(\d{3}):\s*([\s\S]*)$/.exec(text);
  const status = statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
  const body = (statusMatch?.[2] ?? text).trim();

  if (!body) {
    return { ...(status !== undefined ? { status } : {}), message: text, shortened: false };
  }

  const message = findMessage(tryParseJson(body));
  if (message && message !== text) {
    return { ...(status !== undefined ? { status } : {}), message, shortened: true };
  }

  return { ...(status !== undefined ? { status } : {}), message: body, shortened: false };
}
