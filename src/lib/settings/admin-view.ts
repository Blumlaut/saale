/**
 * `AdminSettings` as the admin pages receive it.
 *
 * The settings route and the branding upload route both answer with a whole
 * settings object, so a page never has to merge two partial responses.
 */

import type { AdminSettings } from "@prisma/client";

export interface AdminSettingsView {
  signupsEnabled: boolean;
  globalModelProvider: string;
  globalModelName: string;
  globalProviderModels: unknown;
  featureDefaults: unknown;
  themeColors: unknown;
  brandingAvatar: string;
}

export function serializeAdminSettings(settings: AdminSettings): AdminSettingsView {
  return {
    signupsEnabled: settings.signupsEnabled,
    globalModelProvider: settings.globalModelProvider,
    globalModelName: settings.globalModelName,
    globalProviderModels: settings.globalProviderModels,
    featureDefaults: settings.featureDefaults,
    themeColors: settings.themeColors,
    brandingAvatar: settings.brandingAvatar,
  };
}
