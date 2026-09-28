/**
 * Token limits for providers whose models are defined by Saale (self-hosted
 * OpenAI-compatible endpoints and discoverable catalogs).
 *
 * Pi sends a model's `maxTokens` as the request's `max_tokens`, clamped to its
 * `contextWindow`. Providers reject an out-of-range request outright — DeepSeek
 * answers `400 Invalid max_tokens value, the valid range of max_tokens is
 * [1, 393216]` — so these values must describe the real endpoint, never a
 * guess. Neither is discoverable from `/models`, so they are stored per
 * provider and set by the user (see `provider_api_key`).
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
 * Validate the model limits in a provider request body.
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
        "Model limits can only be configured for OpenAI-compatible providers (OpenAI-compatible, OpenRouter, Together, Fireworks, Hugging Face)",
    };
  }

  return { limits: { contextWindow, maxOutputTokens } };
}

/**
 * Model limit fields for a provider's model definitions, falling back to Pi's
 * defaults when the user configured nothing.
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
