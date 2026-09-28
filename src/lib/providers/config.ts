/**
 * Provider knowledge shared by the provider API routes, the model runtime and
 * the settings UI. Pure data — no database or Node-only imports, so client
 * components can import it directly.
 */

/** Known providers with their display labels. */
export const PROVIDERS = {
  anthropic: { label: "Anthropic" },
  openai: { label: "OpenAI" },
  google: { label: "Google" },
  deepseek: { label: "DeepSeek" },
  xai: { label: "xAI (Grok)" },
  groq: { label: "Groq" },
  cerebras: { label: "Cerebras" },
  openrouter: { label: "OpenRouter" },
  mistral: { label: "Mistral" },
  together: { label: "Together AI" },
  fireworks: { label: "Fireworks" },
  huggingface: { label: "Hugging Face" },
  custom: { label: "OpenAI-compatible" },
} as const;

export type ProviderId = keyof typeof PROVIDERS;

/**
 * Providers whose model list is fetched from an OpenAI-compatible `/models`
 * endpoint instead of using Pi's built-in catalog.
 */
export const DISCOVERABLE_PROVIDERS = new Set<string>([
  "openrouter",
  "together",
  "fireworks",
  "huggingface",
]);

/** Base URLs for the OpenAI-compatible endpoints of discoverable providers. */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  // The bare host redirects to the sign-in page (307), so `/models` returned
  // HTML and discovery silently found nothing.
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  // api-inference.huggingface.com is gone (301 to the .co host, which has no
  // OpenAI-compatible listing); the router is the current endpoint.
  huggingface: "https://router.huggingface.co/v1",
};

/** Get the base URL for a known provider's OpenAI-compatible API. */
export function getProviderBaseUrl(provider: string): string | null {
  return PROVIDER_BASE_URLS[provider] ?? null;
}

/**
 * Whether Saale defines this provider's models itself (from a `/models`
 * response), rather than reading them from Pi's catalog.
 *
 * These are exactly the providers whose per-model metadata is Saale's to record:
 * Pi knows nothing about a model it has never heard of, so the context window,
 * output cap and capabilities (vision) of these providers' models are the
 * user's to set. Kept derived from the discovery list so the two can never
 * drift apart: a provider whose models Saale registers must be configurable.
 */
export function definesProviderModels(provider: string): boolean {
  return provider === "custom" || DISCOVERABLE_PROVIDERS.has(provider);
}
