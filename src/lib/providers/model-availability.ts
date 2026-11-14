/**
 * The admin's per-provider model switches.
 *
 * Stored in `AdminSettings.globalProviderModels` as one entry per provider the
 * admin has configured, and read by every list of models Saale offers, chat and
 * non-chat alike.
 */

import { prisma } from "@/lib/db";

/** One provider's switch, as the admin panel saves it. */
export interface ProviderModelConfig {
  enabled: boolean;
  models?: string[];
}

/** The instance's model switches, or null when nobody restricted anything. */
export async function readGlobalModelConfig(): Promise<Record<string, ProviderModelConfig> | null> {
  const settings = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { globalProviderModels: true },
  });

  return (settings?.globalProviderModels as unknown as Record<string, ProviderModelConfig>) ?? null;
}

/**
 * Whether the admin's global configuration allows a model.
 *
 * The admin stores one entry per provider they have configured:
 *
 * - `enabled: false` is the provider switch. every model of that provider is
 *   off.
 * - a non-empty `models` list is an allowlist.
 * - anything else (no entry, or an entry without a model list) means "no
 *   restriction".
 *
 * An *empty* list deliberately means the same as no list. It used to mean "all
 * disabled", but the admin UI cannot tell an empty selection from a provider it
 * simply saved without touching, so a single Save silently switched off every
 * model of every provider the admin had not toggled. including a local
 * endpoint's, which then also disappeared from the very list used to switch it
 * back on. Turning a provider off is what the provider switch (`enabled`) is
 * for.
 */
export function isModelAllowed(
  globalConfig: Record<string, ProviderModelConfig> | null,
  provider: string,
  modelId: string,
): boolean {
  if (!globalConfig) return true;

  const providerConfig = globalConfig[provider];
  if (!providerConfig) return true; // not in config = allowed

  if (providerConfig.enabled === false) return false;

  if (providerConfig.models && providerConfig.models.length > 0) {
    return providerConfig.models.includes(modelId);
  }

  return true;
}
