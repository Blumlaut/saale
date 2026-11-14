/**
 * A bare settings row, with the defaults Prisma would fill in.
 *
 * The registry tests project properties through a row and the writer tests feed
 * one to a patch, so the full shape lives here once. A new column is added here
 * and nothing else.
 */

import type { AdminSettings, AppSettings } from "@prisma/client";

export function userSettingsRow(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "settings-1",
    userId: "user-1",
    defaultModelProvider: "",
    defaultModelName: "",
    defaultThinkingLevel: "default",
    theme: "system",
    compactActivity: true,
    telegramToolNotices: false,
    agentCustomInstructions: null,
    coderCustomInstructions: null,
    emailWritingStyle: null,
    purposeModelOverrides: null,
    disabledModels: null,
    defaultToolConfig: null,
    coderToolConfig: null,
    toolPolicies: null,
    toolExposure: null,
    approvalDecisionModel: null,
    imageSizes: [],
    imageModel: null,
    githubSource: "",
    sidebarItems: null,
    pushNotifications: null,
    features: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

export function adminSettingsRow(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    id: "global",
    signupsEnabled: true,
    minPasswordLength: 8,
    requireTwoFactor: false,
    webSearchEngines: [],
    webSearchCategories: ["general"],
    webSearchSafeSearch: 0,
    webSearchLanguage: "all",
    webSearchResultsPerCall: 10,
    webFetchMaxChars: 50_000,
    webFetchTimeoutMs: 15_000,
    webFetchMaxRedirects: 5,
    voiceEnabled: true,
    voiceModel: null,
    voiceLanguage: null,
    approvalDecisionModel: null,
    imageModel: null,
    commitAttributionEnabled: false,
    commitAttributionText: "",
    githubMethod: "choice",
    githubTokenPrecedence: "app",
    globalModelProvider: "",
    globalModelName: "",
    globalProviderModels: null,
    featureDefaults: null,
    piPluginsDir: "",
    piPluginsEnabled: false,
    piPluginsUi: false,
    piPluginStates: null,
    themeColors: null,
    workspaceName: "",
    brandingAvatar: "",
    updatedAt: new Date(0),
    ...overrides,
  };
}
