/**
 * The provider catalog, read from Pi.
 *
 * Pi's model runtime already holds every provider it can talk to — id, display
 * name, base URL, how each one authenticates, and how many models it serves.
 * Saale lists that rather than keeping a list of its own, so a provider Pi gains
 * appears in Saale's settings with nothing to change here.
 *
 * Saale's own OpenAI-compatible endpoint is appended: Pi cannot know about an
 * endpoint the user runs.
 */

import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  CUSTOM_PROVIDER_ID,
  CUSTOM_PROVIDER_LABEL,
  definesProviderModels,
} from "@/lib/providers/config";

/** One way a provider can be authenticated, as Pi describes it. */
export interface ProviderAuthMethod {
  type: "api_key" | "oauth";
  /** What Pi calls this method, e.g. "Anthropic API key". */
  label: string;
  /** OAuth access backed by a provider subscription (Claude Pro/Max, ChatGPT…). */
  subscription: boolean;
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  baseUrl: string | null;
  /** Empty when the provider only accepts ambient credentials (AWS, ADC). */
  methods: ProviderAuthMethod[];
  /** Models Pi currently serves for this provider. */
  modelCount: number;
  /** Whether Saale defines this provider's models, so their metadata is editable. */
  modelsConfigurable: boolean;
  /** Saale's own OpenAI-compatible endpoint rather than one of Pi's providers. */
  custom: boolean;
}

/** A catalog entry plus what the signed-in scope has configured for it. */
export interface ProviderCatalogView extends ProviderCatalogEntry {
  configured: boolean;
  /** How Pi resolved the auth: "stored", "runtime", "environment", or null. */
  source: string | null;
  /** Configured globally by an admin rather than by the caller. */
  isGlobal: boolean;
}
/** The auth methods Pi defines for one provider. */
function authMethods(provider: Provider): ProviderAuthMethod[] {
  const methods: ProviderAuthMethod[] = [];
  if (provider.auth.apiKey) {
    methods.push({
      type: "api_key",
      label: provider.auth.apiKey.name,
      subscription: false,
    });
  }
  if (provider.auth.oauth) {
    methods.push({
      type: "oauth",
      label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
      subscription: provider.auth.oauth.isSubscription === true,
    });
  }
  return methods;
}

/**
 * Every provider a scope can configure, with its current model count.
 *
 * A provider Pi serves no chat models for is left out — there would be nothing
 * to select — unless it is configured, so a stored credential always stays
 * visible (and removable) in the UI.
 */
export function providerCatalog(modelRuntime: ModelRuntime): ProviderCatalogEntry[] {
  const entries: ProviderCatalogEntry[] = [];

  for (const provider of modelRuntime.getProviders()) {
    // Saale's own endpoint is appended below: once it is registered, the
    // runtime also reports it, and it must not appear twice.
    if (provider.id === CUSTOM_PROVIDER_ID) continue;

    const modelCount = provider.getModels().length;
    const configured = modelRuntime.getProviderAuthStatus(provider.id).configured;
    if (modelCount === 0 && !configured) continue;

    entries.push({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? null,
      methods: authMethods(provider),
      modelCount,
      modelsConfigurable: definesProviderModels(provider.id),
      custom: false,
    });
  }

  entries.push({
    id: CUSTOM_PROVIDER_ID,
    name: CUSTOM_PROVIDER_LABEL,
    baseUrl: null,
    methods: [
      { type: "api_key", label: "API key (optional for a local server)", subscription: false },
    ],
    modelCount: modelRuntime.getModels(CUSTOM_PROVIDER_ID).length,
    modelsConfigurable: true,
    custom: true,
  });

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
