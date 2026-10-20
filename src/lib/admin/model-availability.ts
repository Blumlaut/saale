/**
 * The admin's model availability, in both directions.
 *
 * `AdminSettings.globalProviderModels` stores one entry per provider:
 *
 *   { "anthropic": { "enabled": false } }
 *   { "openai": { "enabled": true, "models": ["gpt-5"] } }
 *   { "groq": { "enabled": true } }
 *
 * The page works with a selection per provider instead. `undefined` for a
 * provider the admin never touched, an empty set for one switched off, and the
 * selected ids otherwise. because that is what the switches show.
 *
 * Keeping the conversion here (rather than inline in the page) is deliberate:
 * the difference between "nothing selected" and "not touched" is invisible in
 * the stored shape, and reading an empty list as "everything off" is what once
 * switched off every model of every provider the admin had merely saved without
 * touching.
 *
 * Pure data. no database or Node-only imports, so the page can import it.
 */

/** What one provider's entry holds. Mirrors the column's shape. */
export interface ProviderModelConfig {
  enabled: boolean;
  models?: string[];
}

/** Provider id → the models the admin selected (`undefined` = untouched). */
export type ProviderModelSelection = Record<string, Set<string>>;

/** Parse the stored column into the page's selection state. */
export function fromGlobalProviderModels(stored: unknown): ProviderModelSelection {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};

  const selection: ProviderModelSelection = {};
  for (const [providerId, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const config = value as ProviderModelConfig;

    if (config.enabled === false) {
      // A switched-off provider shows as nothing selected.
      selection[providerId] = new Set();
    } else if (Array.isArray(config.models) && config.models.length > 0) {
      selection[providerId] = new Set(config.models);
    }
    // Everything else. no entry, no list, or an empty list. is untouched.
  }
  return selection;
}

/** Build the stored column from the page's selection state. */
export function toGlobalProviderModels(
  providerIds: readonly string[],
  selection: ProviderModelSelection,
): Record<string, ProviderModelConfig> {
  const stored: Record<string, ProviderModelConfig> = {};

  for (const providerId of providerIds) {
    const selected = selection[providerId];
    if (selected === undefined) {
      // Never touched: no restriction, and no list that could be read as one.
      stored[providerId] = { enabled: true };
    } else if (selected.size === 0) {
      stored[providerId] = { enabled: false };
    } else {
      stored[providerId] = { enabled: true, models: Array.from(selected) };
    }
  }

  return stored;
}
