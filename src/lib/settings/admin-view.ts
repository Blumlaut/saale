/**
 * `AdminSettings` as the admin pages receive it.
 *
 * The settings route and the branding upload route both answer with a whole
 * settings object, so a page never has to merge two partial responses.
 */

import type { AdminSettings } from "@prisma/client";

export interface AdminSettingsView {
  signupsEnabled: boolean;
  minPasswordLength: number;
  requireTwoFactor: boolean;
  globalModelProvider: string;
  globalModelName: string;
  globalProviderModels: unknown;
  featureDefaults: unknown;
  themeColors: unknown;
  workspaceName: string;
  brandingAvatar: string;
  webSearchEngines: string[];
  webSearchCategories: string[];
  webSearchSafeSearch: number;
  webSearchLanguage: string;
  webSearchResultsPerCall: number;
  webFetchMaxChars: number;
  webFetchTimeoutMs: number;
  webFetchMaxRedirects: number;
  voiceEnabled: boolean;
  voiceModel: string | null;
  voiceLanguage: string | null;
  /** Decision model that judges what Auto would run, as `provider:model`. */
  approvalDecisionModel: string | null;
}

export function serializeAdminSettings(settings: AdminSettings): AdminSettingsView {
  return {
    signupsEnabled: settings.signupsEnabled,
    minPasswordLength: settings.minPasswordLength,
    requireTwoFactor: settings.requireTwoFactor,
    globalModelProvider: settings.globalModelProvider,
    globalModelName: settings.globalModelName,
    globalProviderModels: settings.globalProviderModels,
    featureDefaults: settings.featureDefaults,
    themeColors: settings.themeColors,
    workspaceName: settings.workspaceName,
    brandingAvatar: settings.brandingAvatar,
    webSearchEngines: settings.webSearchEngines,
    webSearchCategories: settings.webSearchCategories,
    webSearchSafeSearch: settings.webSearchSafeSearch,
    webSearchLanguage: settings.webSearchLanguage,
    webSearchResultsPerCall: settings.webSearchResultsPerCall,
    webFetchMaxChars: settings.webFetchMaxChars,
    webFetchTimeoutMs: settings.webFetchTimeoutMs,
    webFetchMaxRedirects: settings.webFetchMaxRedirects,
    voiceEnabled: settings.voiceEnabled,
    voiceModel: settings.voiceModel,
    voiceLanguage: settings.voiceLanguage,
    approvalDecisionModel: settings.approvalDecisionModel,
  };
}
