/**
 * The one provider Saale defines itself.
 *
 * Every other provider. its display name, its base URL, its models, and how it
 * authenticates. comes from Pi's own model runtime (`pi-ai`'s provider catalog
 * plus a `ModelRuntime`'s registered providers), so a provider Pi adds appears
 * in Saale with nothing to change here. Pi cannot know about an endpoint the
 * user runs themselves, which is what this describes.
 *
 * Every endpoint is its own provider, `custom-<slug>`, so a scope can link as
 * many as it likes and a model reference (`custom-llamacpp:qwen3-32b`) says
 * which one it came from. `CUSTOM_PROVIDER_ID` is the id endpoint rows were
 * stored under while there was only one per scope.
 *
 * Pure data. no database or Node-only imports, so client components can import
 * it directly.
 */

/** The provider id the first endpoint of a scope was stored under. */
export const CUSTOM_PROVIDER_ID = "custom";

/** Display name of the OpenAI-compatible endpoint provider. */
export const CUSTOM_PROVIDER_LABEL = "OpenAI-compatible";

/** Every endpoint's provider id starts with this. */
const ENDPOINT_PREFIX = `${CUSTOM_PROVIDER_ID}-`;

/** How much of a name ends up in the provider id. */
const MAX_SLUG_LENGTH = 32;

/**
 * An endpoint's provider id, from the name it goes by.
 *
 * A model reference splits on the first `:` or `/`, so the id holds neither.
 */
export function endpointProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");
  return `${ENDPOINT_PREFIX}${slug || "endpoint"}`;
}

/** Whether a provider id names an endpoint Saale defines rather than one of Pi's. */
export function isEndpointProvider(provider: string): boolean {
  return provider === CUSTOM_PROVIDER_ID || provider.startsWith(ENDPOINT_PREFIX);
}

/**
 * Whether Saale defines this provider's models itself, rather than reading them
 * from Pi's catalog.
 *
 * These are exactly the providers whose per-model metadata is Saale's to record:
 * Pi knows nothing about a model it has never heard of, so the context window,
 * output cap and capabilities (vision) of their models are the user's to set.
 */
export function definesProviderModels(provider: string): boolean {
  return isEndpointProvider(provider);
}
