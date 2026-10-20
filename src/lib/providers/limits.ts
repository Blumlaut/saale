/**
 * Token limits for the providers whose models are defined by Saale (the
 * self-hosted OpenAI-compatible endpoint; every other provider's models come
 * from Pi's catalog, which states their limits).
 *
 * Pi sends a model's `maxTokens` as the request's `max_tokens`, clamped to its
 * `contextWindow`, and compacts a conversation against that window. Providers
 * reject an out-of-range request outright — DeepSeek answers `400 Invalid
 * max_tokens value, the valid range of max_tokens is [1, 393216]` — so these
 * values must describe the real endpoint, never a guess. Neither can be read
 * from an OpenAI-compatible endpoint, so they are stored per provider and set by
 * the user (see `provider_api_key`).
 *
 * Two levels, because one endpoint can serve models that disagree: the row
 * carries a default for every model the endpoint serves, and a single model
 * overrides it in the capability map (see `./capabilities`). A model that sets
 * nothing inherits the row's default; the row setting nothing falls back to Pi's
 * own defaults.
 */

import { definesProviderModels } from "./config";

/**
 * Fallbacks for a provider the user hasn't configured limits for. These mirror
 * Pi's own defaults for a model definition without explicit limits, so an
 * unconfigured provider behaves exactly as Pi does on its own.
 */
export const PI_DEFAULT_CONTEXT_WINDOW = 128_000;
export const PI_DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Upper bound for a configured limit (1B) — guards typos and numeric overflow. */
const MAX_TOKEN_LIMIT = 1_000_000_000;

/** Model limits a user configured for a provider (null = use Pi's default). */
export interface ProviderModelLimits {
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/**
 * Parse a user-supplied token limit.
 *
 * @returns the value, `null` when the input is empty or explicitly cleared,
 * or `undefined` when the input is not a valid token limit.
 */
export function parseTokenLimit(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TOKEN_LIMIT) return undefined;
  return parsed;
}

/**
 * Reject a pair whose output cap cannot fit its own context window.
 *
 * Pi would clamp it silently, leaving a stored number that describes nothing.
 */
function rejectInvertedPair(limits: ProviderModelLimits): string | null {
  const { contextWindow, maxOutputTokens } = limits;
  if (contextWindow === null || maxOutputTokens === null) return null;
  if (maxOutputTokens <= contextWindow) return null;
  return "maxOutputTokens cannot exceed contextWindow";
}

/**
 * Validate the endpoint-wide defaults in a provider request body.
 *
 * @returns the parsed limits, or an error message to return as a 400.
 */
export function parseProviderLimits(
  provider: string,
  body: { contextWindow?: unknown; maxOutputTokens?: unknown },
): { limits: ProviderModelLimits } | { error: string } {
  const contextWindow = parseTokenLimit(body.contextWindow);
  const maxOutputTokens = parseTokenLimit(body.maxOutputTokens);

  if (contextWindow === undefined) {
    return { error: "contextWindow must be a positive integer" };
  }
  if (maxOutputTokens === undefined) {
    return { error: "maxOutputTokens must be a positive integer" };
  }
  if ((contextWindow !== null || maxOutputTokens !== null) && !definesProviderModels(provider)) {
    return {
      error:
        "Model limits can only be configured for the OpenAI-compatible endpoint — Pi's catalog states every other provider's limits",
    };
  }

  const inverted = rejectInvertedPair({ contextWindow, maxOutputTokens });
  if (inverted) return { error: inverted };

  return { limits: { contextWindow, maxOutputTokens } };
}

/** A per-model limit edit: a key the caller omits is left as stored. */
export interface ModelLimitEdit {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

/**
 * Validate the per-model limits in a request body.
 *
 * Unlike the endpoint defaults, an omitted field means "leave the stored value
 * alone" — the editor writes one field at a time, and clearing one must not
 * reset the other.
 *
 * @returns the parsed edit, or an error message to return as a 400.
 */
export function parseModelLimitEdit(body: {
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
}): ModelLimitEdit | { error: string } {
  const edit: ModelLimitEdit = {};

  if (body.contextWindow !== undefined) {
    const contextWindow = parseTokenLimit(body.contextWindow);
    if (contextWindow === undefined) {
      return { error: "contextWindow must be a positive integer" };
    }
    edit.contextWindow = contextWindow;
  }

  if (body.maxOutputTokens !== undefined) {
    const maxOutputTokens = parseTokenLimit(body.maxOutputTokens);
    if (maxOutputTokens === undefined) {
      return { error: "maxOutputTokens must be a positive integer" };
    }
    edit.maxOutputTokens = maxOutputTokens;
  }

  const inverted = rejectInvertedPair({
    contextWindow: edit.contextWindow ?? null,
    maxOutputTokens: edit.maxOutputTokens ?? null,
  });
  if (inverted) return { error: inverted };

  return edit;
}

/**
 * The limits a model's definition gets, from every source that can state one.
 *
 * The user's per-model value wins, then the endpoint-wide default they set on
 * the provider row, then what the endpoint's own listing reports, then Pi's
 * catalog for a model it knows, and Pi's defaults for whatever nobody stated.
 */
export interface ModelLimitSources {
  /** What the user set for this one model. */
  model?: { contextWindow?: number; maxOutputTokens?: number } | undefined;
  /** The endpoint-wide default the user set on the provider row. */
  endpoint?: ProviderModelLimits | undefined;
  /** What the endpoint's `/models` listing states for this model. */
  reported?: { contextWindow?: number; maxOutputTokens?: number } | undefined;
  /** Pi's catalog entry, for a model Pi knows. */
  catalog?: { contextWindow: number; maxTokens: number } | undefined;
}

/** Model limit fields for a definition, falling back to Pi's defaults. */
export function resolveModelLimits(sources: ModelLimitSources): {
  contextWindow: number;
  maxTokens: number;
} {
  const { model, endpoint, reported, catalog } = sources;
  return limitFields({
    contextWindow:
      model?.contextWindow ??
      endpoint?.contextWindow ??
      reported?.contextWindow ??
      catalog?.contextWindow ??
      null,
    maxOutputTokens:
      model?.maxOutputTokens ??
      endpoint?.maxOutputTokens ??
      reported?.maxOutputTokens ??
      catalog?.maxTokens ??
      null,
  });
}

/**
 * Model limit fields for a definition, falling back to Pi's defaults for a
 * field nobody configured.
 */
export function limitFields(limits: ProviderModelLimits): {
  contextWindow: number;
  maxTokens: number;
} {
  return {
    contextWindow: limits.contextWindow ?? PI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: limits.maxOutputTokens ?? PI_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}
