/**
 * The one provider Saale defines itself.
 *
 * Every other provider. its display name, its base URL, its models, and how it
 * authenticates. comes from Pi's own model runtime (`pi-ai`'s provider catalog
 * plus a `ModelRuntime`'s registered providers), so a provider Pi adds appears
 * in Saale with nothing to change here. Pi cannot know about an endpoint the
 * user runs themselves, which is what this describes.
 *
 * Pure data. no database or Node-only imports, so client components can import
 * it directly.
 */

/** The provider id Saale registers an OpenAI-compatible endpoint under. */
export const CUSTOM_PROVIDER_ID = "custom";

/** Display name of the OpenAI-compatible endpoint provider. */
export const CUSTOM_PROVIDER_LABEL = "OpenAI-compatible";

/**
 * Whether Saale defines this provider's models itself, rather than reading them
 * from Pi's catalog.
 *
 * These are exactly the providers whose per-model metadata is Saale's to record:
 * Pi knows nothing about a model it has never heard of, so the context window,
 * output cap and capabilities (vision) of their models are the user's to set.
 */
export function definesProviderModels(provider: string): boolean {
  return provider === CUSTOM_PROVIDER_ID;
}
