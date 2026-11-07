/**
 * Saale settings registry. the single source of truth for every configurable
 * value in `AppSettings` (per user) and `AdminSettings` (global).
 *
 * Everything that reads or writes a setting goes through here:
 *
 * - The agent's `settings_list` / `settings_set` tools address properties by
 *   their dotted key.
 * - The settings API routes apply column patches, which this module normalizes
 *   and validates property by property.
 *
 * Most of the registry is **derived** from registries that already exist. tool
 * categories, tool policies, model purposes, thinking levels and sidebar items
 *. so adding a tool category or a purpose needs no change here at all. Adding
 * a plain column to `AppSettings`/`AdminSettings` does need one entry (its
 * label, description and validation cannot be inferred). `__tests__` compares
 * this registry against `prisma/schema.prisma`, so a forgotten entry fails CI
 * instead of silently leaving the setting unreachable.
 *
 * Each property declares:
 * - `key`    . the dotted path the model uses (`tools.category.email.enabled`)
 * - `columns`. the row columns it owns (drives coverage tests and patches)
 * - `schema` . validation for a set (`null` means "restore the default")
 * - `read` / `write`. pure projections in and out of the row
 * - `apply`  . `sessions` when a pooled agent session must be rebuilt
 *
 * Secrets never live in these tables, so nothing here is redacted.
 */

import { Prisma, type AdminSettings, type AppSettings } from "@prisma/client";
import { z } from "zod";
import {
  clampMinPasswordLength,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@/lib/auth/password";
import {
  clampSetting,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_RESULTS_PER_CALL,
  MAX_FETCH_TIMEOUT_MS,
  MAX_MAX_CHARS,
  MAX_MAX_REDIRECTS,
  MAX_RESULTS_PER_CALL,
  MIN_FETCH_TIMEOUT_MS,
  MIN_MAX_CHARS,
  safeSearchLevel,
} from "@/lib/web/tools-config";
import {
  isDefaultSidebarNav,
  isSidebarNavPinned,
  normalizeSidebarNav,
  SIDEBAR_NAV_ITEMS,
  type SidebarNavEntry,
} from "@/lib/navigation/sidebar-nav";
import { formatModelReference, splitModelReference } from "@/lib/pi/model-ref";
import { MAX_WORKSPACE_NAME_LENGTH } from "@/lib/branding/workspace-name";
import { DEFAULT_THEME, THEME_NAMES } from "@/lib/theme";
import {
  BRAND_COLOR_KEYS,
  BRAND_MODES,
  isDefaultBrandColors,
  normalizeHex,
  normalizeThemeColors,
} from "@/lib/branding/theme";
import { isBrandingAvatarName } from "@/lib/branding/avatar-name";
import {
  DEFAULT_THINKING_LEVEL_SETTING,
  isThinkingLevelSetting,
  THINKING_LEVEL_OPTIONS,
} from "@/lib/pi/thinking-levels";
import {
  isToolExposure,
  TOOL_CATEGORIES,
  TOOL_EXPOSURES,
  type ToolCategoryKey,
} from "@/lib/pi/tool-categories";
import { CODER_TOOL_DEFAULTS } from "@/lib/pi/coder-tools";
import { DEFAULT_ATTRIBUTION_LINE, MAX_ATTRIBUTION_LENGTH } from "@/lib/pi/commit-attribution";
import { ALL_TOOL_INFOS, type ToolPolicy } from "@/lib/pi/tool-infos";
import { getAllPurposes } from "@/lib/pi/purposes";
import { normalizeToolExposure } from "@/lib/pi/tool-exposure-rules";
import { FEATURES, normalizeFeatureOverrides } from "@/lib/permissions/features";
import {
  isCategoryEnabled,
  normalizeNotificationPreferences,
  NOTIFICATION_CATEGORIES,
} from "@/lib/notifications/preferences";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PropertyScope = "user" | "admin";

/**
 * What a change invalidates.
 *
 * - `none`        . read fresh on the next request / client render.
 * - `sessions`    . baked into a pooled agent session (model, tools, exposure,
 *   system prompt), so the acting user's pooled sessions must be evicted to
 *   rebuild.
 * - `allSessions` . read by every tenant's session (the global plugins), so
 *   every pooled session is evicted.
 */
export type PropertyApply = "none" | "sessions" | "allSessions";

type AppSettingsUpdate = Prisma.AppSettingsUncheckedUpdateInput;
type AdminSettingsUpdate = Prisma.AdminSettingsUncheckedUpdateInput;

interface PropertyCommon {
  /** Dotted path the model addresses. */
  key: string;
  /** Coarse bucket used to list properties in batches. */
  group: string;
  label: string;
  description: string;
  /** Allowed values, when the value is an enumeration. */
  values?: readonly string[];
  /** Row columns this property owns. */
  columns: readonly string[];
  apply: PropertyApply;
}

export interface UserProperty extends PropertyCommon {
  scope: "user";
  schema: z.ZodType;
  read: (row: AppSettings) => unknown;
  write: (row: AppSettings, value: unknown) => AppSettingsUpdate;
}

export interface AdminProperty extends PropertyCommon {
  scope: "admin";
  schema: z.ZodType;
  read: (row: AdminSettings) => unknown;
  write: (row: AdminSettings, value: unknown) => AdminSettingsUpdate;
}

export type Property = UserProperty | AdminProperty;

// ─── Shared schemas ──────────────────────────────────────────────────────────

const THINKING_LEVEL_VALUES = THINKING_LEVEL_OPTIONS.map((option) => option.id);
const EXPOSURE_VALUES = TOOL_EXPOSURES.map((option) => option.value);
const POLICY_VALUES: readonly ToolPolicy[] = ["allow", "auto", "ask", "off"];

/** `provider:model`. the same form the settings UI stores. */
const modelReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => splitModelReference(value) !== undefined,
    'Use "provider:model", for example "anthropic:claude-sonnet-4".',
  );

const thinkingLevelSchema = z
  .string()
  .refine(
    isThinkingLevelSetting,
    `Use one of: ${THINKING_LEVEL_VALUES.join(", ")}. "default" leaves the level to Pi.`,
  );

const exposureSchema = z
  .string()
  .refine(isToolExposure, `Use one of: ${EXPOSURE_VALUES.join(", ")}.`);

const policySchema = z
  .string()
  .refine(
    (value): value is ToolPolicy => (POLICY_VALUES as readonly string[]).includes(value),
    `Use one of: ${POLICY_VALUES.join(", ")}.`,
  );

// ─── Row helpers ─────────────────────────────────────────────────────────────

/** A JSON column as a plain object (an absent or malformed column reads empty). */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A JSON column written back, or cleared when it holds nothing. */
type JsonColumnValue = Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;

function orDbNull(value: Record<string, unknown>): JsonColumnValue {
  return Object.keys(value).length > 0 ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
}

/**
 * Canonical `defaultToolConfig`: known categories only, and only entries that
 * differ from the category default (the row stays sparse).
 */
function normalizeToolConfig(value: unknown): Record<string, boolean> {
  const stored = asRecord(value);
  const result: Record<string, boolean> = {};
  for (const category of TOOL_CATEGORIES) {
    const entry = stored[category.key];
    if (typeof entry !== "boolean") continue;
    if (entry === category.defaultEnabled) continue;
    result[category.key] = entry;
  }
  return result;
}

/** Canonical `toolPolicies`: known tools only, valid policies, defaults dropped. */
function normalizeToolPolicies(value: unknown): Record<string, string> {
  const stored = asRecord(value);
  const result: Record<string, string> = {};
  for (const tool of ALL_TOOL_INFOS) {
    const entry = stored[tool.name];
    if (typeof entry !== "string") continue;
    if (!(POLICY_VALUES as readonly string[]).includes(entry)) continue;
    if (entry === tool.defaultPolicy) continue;
    result[tool.name] = entry;
  }
  return result;
}

/** Canonical `purposeModelOverrides`: known purposes with a complete model ref. */
function normalizePurposeOverrides(value: unknown): Record<string, ModelRefObject> {
  const stored = asRecord(value);
  const result: Record<string, ModelRefObject> = {};
  for (const purpose of getAllPurposes()) {
    const entry = stored[purpose.id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { provider, model } = entry as { provider?: unknown; model?: unknown };
    if (typeof provider !== "string" || typeof model !== "string") continue;
    if (!provider.trim() || !model.trim()) continue;
    result[purpose.id] = { provider, model };
  }
  return result;
}

interface ModelRefObject {
  provider: string;
  model: string;
}

// ─── Groups ──────────────────────────────────────────────────────────────────

const GROUP = {
  appearance: "appearance",
  models: "models",
  agent: "agent",
  tools: "tools",
  coder: "coder",
  sidebar: "sidebar",
  notifications: "notifications",
  telegram: "telegram",
  admin: "admin",
  branding: "branding",
  plugins: "plugins",
} as const;

// ─── Hand-written properties ─────────────────────────────────────────────────
//
// Everything below is the irreducible part: a plain column needs a human
// description and validation. Everything derivable is generated further down.

const SCALAR_PROPERTIES: UserProperty[] = [
  {
    key: "theme",
    group: GROUP.appearance,
    label: "Theme",
    description: `Interface colour scheme: ${THEME_NAMES.map((name) => `"${name}"`).join(", ")}.`,
    values: THEME_NAMES,
    columns: ["theme"],
    apply: "none",
    scope: "user",
    schema: z.enum(THEME_NAMES),
    read: (row) => row.theme,
    write: (_row, value) => ({
      theme: value === null ? DEFAULT_THEME : String(value),
    }),
  },
  {
    key: "appearance.compactActivity",
    group: GROUP.appearance,
    label: "Compact activity",
    description:
      "Collapse a turn's reasoning and tool calls into one line each. a running tool count with the tools' own icons. instead of a card per step. Each line expands to the full detail. Set to false for the step-by-step transcript.",
    columns: ["compactActivity"],
    apply: "none",
    scope: "user",
    schema: z.boolean(),
    read: (row) => row.compactActivity,
    write: (_row, value) => ({
      compactActivity: value === null ? true : Boolean(value),
    }),
  },
  {
    key: "telegram.toolNotices",
    group: GROUP.telegram,
    label: "Telegram tool notices",
    description:
      "Send Telegram a line for every tool the agent runs, above its answer. Off sends only what the agent says.",
    columns: ["telegramToolNotices"],
    apply: "none",
    scope: "user",
    schema: z.boolean(),
    read: (row) => row.telegramToolNotices,
    write: (_row, value) => ({
      telegramToolNotices: value === null ? false : Boolean(value),
    }),
  },
  {
    key: "models.default",
    group: GROUP.models,
    label: "Default model",
    description:
      'Model used by chat and AI features that have no purpose-specific model, as "provider:model". Set to null to clear it.',
    columns: ["defaultModelProvider", "defaultModelName"],
    apply: "sessions",
    scope: "user",
    schema: modelReferenceSchema,
    read: (row) => formatModelReference(row.defaultModelProvider, row.defaultModelName),
    write: (_row, value) => {
      const reference = splitModelReference(value === null ? null : String(value));
      if (!reference) return { defaultModelProvider: "", defaultModelName: "" };
      return { defaultModelProvider: reference.provider, defaultModelName: reference.name };
    },
  },
  {
    key: "models.thinkingLevel",
    group: GROUP.models,
    label: "Thinking level",
    description: `Reasoning effort for AI runs. One of: ${THINKING_LEVEL_VALUES.join(", ")}. "default" lets the model decide.`,
    values: THINKING_LEVEL_VALUES,
    columns: ["defaultThinkingLevel"],
    apply: "sessions",
    scope: "user",
    schema: thinkingLevelSchema,
    read: (row) => row.defaultThinkingLevel,
    write: (_row, value) => ({
      defaultThinkingLevel: value === null ? DEFAULT_THINKING_LEVEL_SETTING : String(value),
    }),
  },
  {
    key: "models.disabled",
    group: GROUP.models,
    label: "Disabled models",
    description:
      'Models hidden from model pickers, as an array of "provider:model". Set to null to enable everything again.',
    columns: ["disabledModels"],
    apply: "none",
    scope: "user",
    schema: z.array(modelReferenceSchema),
    read: (row) => (Array.isArray(row.disabledModels) ? row.disabledModels : []),
    write: (_row, value) => ({
      disabledModels:
        Array.isArray(value) && value.length > 0 ? (value as Prisma.InputJsonValue) : [],
    }),
  },
  {
    key: "prompt.customInstructions",
    group: GROUP.agent,
    label: "Custom instructions",
    description:
      "Extra instructions appended to the agent's system prompt, applied to new and rebuilt sessions. Set to null to remove them.",
    columns: ["agentCustomInstructions"],
    apply: "sessions",
    scope: "user",
    schema: z.string(),
    read: (row) => row.agentCustomInstructions,
    write: (_row, value) => ({
      agentCustomInstructions: value === null ? null : String(value),
    }),
  },
  {
    key: "prompt.coderInstructions",
    group: GROUP.agent,
    label: "Coder instructions",
    description:
      "Extra instructions for coder chats. They replace the custom chat instructions there and are appended to the coder system prompt, applied to new and rebuilt coder sessions. Set to null to remove them.",
    columns: ["coderCustomInstructions"],
    apply: "sessions",
    scope: "user",
    schema: z.string(),
    read: (row) => row.coderCustomInstructions,
    write: (_row, value) => ({
      coderCustomInstructions: value === null ? null : String(value),
    }),
  },
  {
    key: "prompt.emailWritingStyle",
    group: GROUP.agent,
    label: "Email writing style",
    description:
      "Style guidance used when drafting email replies, applied to new drafts. Set to null to remove it.",
    columns: ["emailWritingStyle"],
    apply: "sessions",
    scope: "user",
    schema: z.string(),
    read: (row) => row.emailWritingStyle,
    write: (_row, value) => ({
      emailWritingStyle: value === null ? null : String(value),
    }),
  },
];

// ─── Derived properties ──────────────────────────────────────────────────────

/** `models.purpose.<id>`. a model override per AI purpose. */
function purposeProperties(): UserProperty[] {
  return getAllPurposes().map((purpose) => ({
    key: `models.purpose.${purpose.id}`,
    group: GROUP.models,
    label: `Model for ${purpose.label}`,
    description: `${purpose.description} Set to null to follow the default model.`,
    columns: ["purposeModelOverrides"],
    apply: "sessions" as const,
    scope: "user" as const,
    schema: modelReferenceSchema,
    read: (row) => {
      const entry = asRecord(row.purposeModelOverrides)[purpose.id];
      if (!entry || typeof entry !== "object") return null;
      const { provider, model } = entry as { provider?: string; model?: string };
      return formatModelReference(provider, model);
    },
    write: (row, value) => {
      const overrides = normalizePurposeOverrides(row.purposeModelOverrides);
      if (value === null) {
        delete overrides[purpose.id];
      } else {
        const reference = splitModelReference(String(value));
        if (!reference) return {};
        overrides[purpose.id] = { provider: reference.provider, model: reference.name };
      }
      return { purposeModelOverrides: orDbNull(overrides) };
    },
  }));
}

/** `tools.category.<key>.enabled`. whether a category is on for new chats. */
function categoryEnabledProperties(): UserProperty[] {
  return TOOL_CATEGORIES.map((category) => ({
    key: `tools.category.${category.key}.enabled`,
    group: GROUP.tools,
    label: `${category.label} enabled`,
    description: `${category.description}. Enabled by default for new chats: ${category.defaultEnabled}. Set to true/false, or null to restore the default.`,
    columns: ["defaultToolConfig"],
    apply: "sessions" as const,
    scope: "user" as const,
    schema: z.boolean(),
    read: (row) => {
      const stored = asRecord(row.defaultToolConfig)[category.key];
      return typeof stored === "boolean" ? stored : category.defaultEnabled;
    },
    write: (row, value) => {
      const config = normalizeToolConfig(row.defaultToolConfig);
      if (value === null) {
        delete config[category.key];
      } else {
        config[category.key] = Boolean(value);
      }
      return { defaultToolConfig: orDbNull(normalizeToolConfig(config)) };
    },
  }));
}

/** `tools.category.<key>.exposure`. how a category's tools reach the model. */
function categoryExposureProperties(): UserProperty[] {
  return TOOL_CATEGORIES.map((category) => ({
    key: `tools.category.${category.key}.exposure`,
    group: GROUP.tools,
    label: `${category.label} exposure`,
    description: `${TOOL_EXPOSURES.map((option) => `${option.value} (${option.description})`).join("; ")}. Default: ${category.defaultExposure}.`,
    values: EXPOSURE_VALUES,
    columns: ["toolExposure"],
    apply: "sessions" as const,
    scope: "user" as const,
    schema: exposureSchema,
    read: (row) => {
      const stored = normalizeToolExposure(row.toolExposure)?.[category.key as ToolCategoryKey];
      return stored ?? category.defaultExposure;
    },
    write: (row, value) => {
      const exposure = { ...(normalizeToolExposure(row.toolExposure) ?? {}) };
      const next = value === null ? category.defaultExposure : String(value);
      if (next === category.defaultExposure) {
        delete exposure[category.key as ToolCategoryKey];
      } else if (isToolExposure(next)) {
        exposure[category.key as ToolCategoryKey] = next;
      }
      // `exposure` is already canonical: unknown categories and entries at the
      // category default were dropped by `normalizeToolExposure`.
      return { toolExposure: orDbNull(exposure) };
    },
  }));
}

/** `tools.policy.<tool>`. the approval policy for one tool. */
function toolPolicyProperties(): UserProperty[] {
  return ALL_TOOL_INFOS.map((tool) => ({
    key: `tools.policy.${tool.name}`,
    group: GROUP.tools,
    label: `${tool.label} policy`,
    description: `${tool.description}. One of: ${POLICY_VALUES.join(", ")}. Default: ${tool.defaultPolicy}.`,
    values: POLICY_VALUES,
    columns: ["toolPolicies"],
    apply: "sessions" as const,
    scope: "user" as const,
    schema: policySchema,
    read: (row) => {
      const stored = asRecord(row.toolPolicies)[tool.name];
      return typeof stored === "string" ? stored : tool.defaultPolicy;
    },
    write: (row, value) => {
      const policies = normalizeToolPolicies(row.toolPolicies);
      if (value === null) {
        delete policies[tool.name];
      } else {
        policies[tool.name] = String(value);
      }
      return { toolPolicies: orDbNull(normalizeToolPolicies(policies)) };
    },
  }));
}

/** A reference as stored: `provider:model`, or null to clear it. */
function normalizeModelReference(value: unknown): string | null {
  const reference = splitModelReference(value === null ? null : String(value));
  return reference ? formatModelReference(reference.provider, reference.name) : null;
}

/** `tools.approvalDecisionModel`. the model that judges what Auto would run. */
const APPROVAL_DECISION_MODEL_PROPERTY: UserProperty = {
  key: "tools.approvalDecisionModel",
  group: GROUP.tools,
  label: "Approval decision model",
  description:
    'Decision model that judges the tool calls the Auto policy would run on its own, as "provider:model". Set to null to follow the instance default. With neither set, the built-in command checks decide.',
  columns: ["approvalDecisionModel"],
  apply: "sessions",
  scope: "user",
  schema: modelReferenceSchema,
  read: (row) => row.approvalDecisionModel,
  write: (_row, value) => ({ approvalDecisionModel: normalizeModelReference(value) }),
};

/**
 * `coder.tools.category.<key>.enabled`. whether a category is on for new coder
 * chats, where the default set is the worktree tools and little else.
 */
function coderCategoryProperties(): UserProperty[] {
  return TOOL_CATEGORIES.map((category) => {
    const fallback = CODER_TOOL_DEFAULTS[category.key];
    return {
      key: `coder.tools.category.${category.key}.enabled`,
      group: GROUP.coder,
      label: `${category.label} in coder chats`,
      description: `${category.description}. Enabled by default for new coder chats: ${fallback}. Set to true/false, or null to restore the default.`,
      columns: ["coderToolConfig"],
      apply: "sessions" as const,
      scope: "user" as const,
      schema: z.boolean(),
      read: (row) => {
        const stored = asRecord(row.coderToolConfig)[category.key];
        return typeof stored === "boolean" ? stored : fallback;
      },
      write: (row, value) => {
        const config = normalizeCoderToolConfig(row.coderToolConfig);
        if (value === null) {
          delete config[category.key];
        } else {
          config[category.key] = Boolean(value);
        }
        return { coderToolConfig: orDbNull(normalizeCoderToolConfig(config)) };
      },
    };
  });
}

/** Canonical `coderToolConfig`: known categories only, defaults dropped. */
function normalizeCoderToolConfig(value: unknown): Record<string, boolean> {
  const stored = asRecord(value);
  const result: Record<string, boolean> = {};
  for (const category of TOOL_CATEGORIES) {
    const entry = stored[category.key];
    if (typeof entry !== "boolean") continue;
    if (entry === CODER_TOOL_DEFAULTS[category.key]) continue;
    result[category.key] = entry;
  }
  return result;
}

/** `sidebar.<item>.hidden`. whether a navigation item is hidden.
 *
 * Pinned items (Settings) are excluded: they cannot be hidden, so a property
 * for them would silently do nothing.
 */
function sidebarProperties(): UserProperty[] {
  return SIDEBAR_NAV_ITEMS.filter((item) => !isSidebarNavPinned(item.id)).map((item) => ({
    key: `sidebar.${item.id}.hidden`,
    group: GROUP.sidebar,
    label: `${item.label} hidden`,
    description: `Hide the ${item.label} item from the dashboard navigation.`,
    columns: ["sidebarItems"],
    apply: "none" as const,
    scope: "user" as const,
    schema: z.boolean(),
    read: (row) =>
      normalizeSidebarNav(row.sidebarItems).find((entry) => entry.id === item.id)?.hidden ?? false,
    write: (row, value) => {
      const hidden = value === null ? false : Boolean(value);
      const entries = normalizeSidebarNav(row.sidebarItems).map((entry) =>
        entry.id === item.id ? { ...entry, hidden } : entry,
      );
      return { sidebarItems: sidebarColumnValue(entries) };
    },
  }));
}

/** `notifications.<category>`. which push notifications a user wants. */
function notificationProperties(): UserProperty[] {
  return NOTIFICATION_CATEGORIES.map((category) => ({
    key: `notifications.${category.key}`,
    group: GROUP.notifications,
    label: category.label,
    description: `${category.description} Set to false to stop sending it, or null to restore the default (true).`,
    columns: ["pushNotifications"],
    apply: "none" as const,
    scope: "user" as const,
    schema: z.boolean(),
    read: (row) => isCategoryEnabled(row.pushNotifications, category.key),
    write: (row, value) => {
      const preferences = normalizeNotificationPreferences(row.pushNotifications);
      if (value === null) {
        delete preferences[category.key];
      } else {
        preferences[category.key] = Boolean(value);
      }
      return { pushNotifications: orDbNull(preferences) };
    },
  }));
}

/** Store a layout, or clear the column when it is the default. */
export function sidebarColumnValue(entries: readonly SidebarNavEntry[]): JsonColumnValue {
  return isDefaultSidebarNav(entries)
    ? Prisma.DbNull
    : (entries.map((entry) => ({ id: entry.id, hidden: entry.hidden })) as Prisma.InputJsonValue);
}

// ─── Admin properties ────────────────────────────────────────────────────────

const providerModelsSchema = z.record(
  z.string(),
  z.object({
    enabled: z.boolean().optional(),
    models: z.array(z.string()).optional(),
  }),
);

/** Feature switches keyed by feature name; unknown names are refused. */
const featureOverridesSchema = z.partialRecord(z.enum(FEATURES), z.boolean());

const pluginStatesSchema = z.record(z.string().min(1), z.object({ enabled: z.boolean() }).strict());

/** One hex colour per brandable token, per mode; an absent token keeps the default. */
const themeColorsSchema = z.partialRecord(
  z.enum(BRAND_MODES),
  z.partialRecord(
    z.enum(BRAND_COLOR_KEYS),
    z
      .string()
      .refine(
        (value) => normalizeHex(value) !== undefined,
        'Use a hex colour, for example "#f97316" or "#f73".',
      ),
  ),
);

/** `piPluginStates` as a plain map: an enabled plugin is stored as absence. */
export function normalizePluginStates(value: unknown): Record<string, { enabled: boolean }> {
  const source = asRecord(value);
  const result: Record<string, { enabled: boolean }> = {};
  for (const [id, entry] of Object.entries(source)) {
    if (!id.trim()) continue;
    const { enabled } = asRecord(entry);
    if (typeof enabled !== "boolean" || enabled) continue;
    result[id] = { enabled };
  }
  return result;
}

const ADMIN_PROPERTY_DEFINITIONS: AdminProperty[] = [
  {
    key: "admin.commitAttributionEnabled",
    group: GROUP.coder,
    label: "Commit attribution",
    description: "Adds the attribution line to every commit a coder chat writes.",
    columns: ["commitAttributionEnabled"],
    apply: "allSessions",
    scope: "admin",
    schema: z.boolean(),
    read: (row) => row.commitAttributionEnabled,
    write: (_row, value) => ({ commitAttributionEnabled: Boolean(value) }),
  },
  {
    key: "admin.commitAttributionText",
    group: GROUP.coder,
    label: "Attribution line",
    description: `The trailer every commit a coder chat writes ends with. A variable such as $SAALE_MODEL is filled in when the commit is made. Empty writes "${DEFAULT_ATTRIBUTION_LINE}". Up to ${MAX_ATTRIBUTION_LENGTH} characters, on one line.`,
    columns: ["commitAttributionText"],
    apply: "allSessions",
    scope: "admin",
    schema: z
      .string()
      .trim()
      .max(MAX_ATTRIBUTION_LENGTH, `Use ${MAX_ATTRIBUTION_LENGTH} characters or fewer.`)
      .refine(
        (value) => !/[\r\n]/.test(value),
        "Use one line: the trailer sits on its own line in the message.",
      ),
    read: (row) => row.commitAttributionText,
    write: (_row, value) => ({
      commitAttributionText: typeof value === "string" ? value.trim() : "",
    }),
  },
  {
    key: "admin.signupsEnabled",
    group: GROUP.admin,
    label: "Sign-ups enabled",
    description: "Whether new accounts can be created on this instance.",
    columns: ["signupsEnabled"],
    apply: "none",
    scope: "admin",
    schema: z.boolean(),
    read: (row) => row.signupsEnabled,
    write: (_row, value) => ({ signupsEnabled: Boolean(value) }),
  },
  {
    key: "admin.minPasswordLength",
    group: GROUP.admin,
    label: "Minimum password length",
    description:
      "Shortest password this instance accepts, checked when an account is created and when a password changes. 8 to 128.",
    columns: ["minPasswordLength"],
    apply: "none",
    scope: "admin",
    schema: z.number().int().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    read: (row) => row.minPasswordLength,
    write: (_row, value) => ({ minPasswordLength: clampMinPasswordLength(value) }),
  },
  {
    key: "admin.requireTwoFactor",
    group: GROUP.admin,
    label: "Require two-factor sign-in",
    description:
      "Sends an account without two-factor to the page that sets it up, which is the only page it can open until it has.",
    columns: ["requireTwoFactor"],
    apply: "none",
    scope: "admin",
    schema: z.boolean(),
    read: (row) => row.requireTwoFactor,
    write: (_row, value) => ({ requireTwoFactor: Boolean(value) }),
  },
  {
    key: "admin.defaultModel",
    group: GROUP.admin,
    label: "Global default model",
    description:
      'Fallback model for every user who has not chosen one, as "provider:model". Set to null to clear it.',
    columns: ["globalModelProvider", "globalModelName"],
    apply: "sessions",
    scope: "admin",
    schema: modelReferenceSchema,
    read: (row) => formatModelReference(row.globalModelProvider, row.globalModelName),
    write: (_row, value) => {
      const reference = splitModelReference(value === null ? null : String(value));
      if (!reference) return { globalModelProvider: "", globalModelName: "" };
      return { globalModelProvider: reference.provider, globalModelName: reference.name };
    },
  },
  {
    key: "admin.approvalDecisionModel",
    group: GROUP.models,
    label: "Approval decision model",
    description:
      'Decision model that judges the tool calls the Auto policy would run on its own, for accounts that have not picked one, as "provider:model". Set to null to leave the built-in command checks.',
    columns: ["approvalDecisionModel"],
    apply: "allSessions",
    scope: "admin",
    schema: modelReferenceSchema,
    read: (row) => row.approvalDecisionModel,
    write: (_row, value) => ({ approvalDecisionModel: normalizeModelReference(value) }),
  },
  {
    key: "admin.providerModels",
    group: GROUP.admin,
    label: "Provider availability",
    description:
      'Per-provider availability, keyed by provider id: { "<provider>": { "enabled": false } } turns a provider off, { "enabled": true, "models": ["gpt-5"] } restricts it to a list. Set to null to allow everything.',
    columns: ["globalProviderModels"],
    apply: "sessions",
    scope: "admin",
    schema: providerModelsSchema,
    read: (row) => row.globalProviderModels,
    write: (_row, value) => ({
      globalProviderModels: value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue),
    }),
  },
  {
    key: "admin.featureDefaults",
    group: GROUP.admin,
    label: "Default features",
    description:
      "Feature switches applied to every regular account that has no override of its own, keyed by feature name. Absent keys keep the built-in default. Set to null for the built-in defaults.",
    columns: ["featureDefaults"],
    apply: "sessions",
    scope: "admin",
    schema: featureOverridesSchema,
    read: (row) => normalizeFeatureOverrides(row.featureDefaults),
    write: (_row, value) => ({
      featureDefaults: orDbNull(normalizeFeatureOverrides(value)),
    }),
  },
  {
    key: "admin.piPluginsEnabled",
    group: GROUP.plugins,
    label: "Global plugins enabled",
    description:
      "Load the plugins in the plugin directory into every session. Plugins run in this process with the server's permissions and can read every account's data, so only reviewed code belongs there.",
    columns: ["piPluginsEnabled"],
    apply: "allSessions",
    scope: "admin",
    schema: z.boolean(),
    read: (row) => row.piPluginsEnabled,
    write: (_row, value) => ({ piPluginsEnabled: Boolean(value) }),
  },
  {
    key: "admin.piPluginsUi",
    group: GROUP.plugins,
    label: "Plugin dialogs",
    description:
      "Let plugins open dialogs in a chat (Pi's extension UI: select, confirm, input, editor, notifications and status lines). A plugin runs inside the app, so a dialog it shows is the plugin asking the user directly. Turned off, a plugin's dialog is cancelled at once.",
    columns: ["piPluginsUi"],
    apply: "allSessions",
    scope: "admin",
    schema: z.boolean(),
    read: (row) => row.piPluginsUi,
    write: (_row, value) => ({ piPluginsUi: Boolean(value) }),
  },
  {
    key: "admin.piPluginsDir",
    group: GROUP.plugins,
    label: "Plugin directory",
    description:
      'Directory scanned for global Pi plugins. A plugin is a folder with an index.ts, an extensions/ folder, or a package.json "pi.extensions" list. Set to null to use PI_GLOBAL_PLUGINS_DIR, then <uploads>/pi_plugins.',
    columns: ["piPluginsDir"],
    apply: "allSessions",
    scope: "admin",
    schema: z.string(),
    read: (row) => row.piPluginsDir,
    write: (_row, value) => ({ piPluginsDir: value === null ? "" : String(value).trim() }),
  },
  {
    key: "admin.piPluginStates",
    group: GROUP.plugins,
    label: "Plugin switches",
    description:
      'Per-plugin switches, keyed by plugin folder name: { "my-plugin": { "enabled": false } }. A plugin absent from the map is on while global plugins are on.',
    columns: ["piPluginStates"],
    apply: "allSessions",
    scope: "admin",
    schema: pluginStatesSchema,
    read: (row) => normalizePluginStates(row.piPluginStates),
    write: (_row, value) => ({ piPluginStates: orDbNull(normalizePluginStates(value)) }),
  },
  {
    key: "admin.themeColors",
    group: GROUP.branding,
    label: "Branding colours",
    description:
      'Accent colours per mode, keyed by mode then token: { "light": { "primary": "#2563eb", "secondary": "#ffffff" }, "dark": { "primary": "#3b82f6" } }. primary is the accent, secondary is the text drawn on it. A secondary that does not read on the accent is shifted until it does. A token that is absent keeps the built-in palette.',
    columns: ["themeColors"],
    apply: "none",
    scope: "admin",
    schema: themeColorsSchema,
    read: (row) => normalizeThemeColors(row.themeColors),
    write: (_row, value) => {
      const colors = normalizeThemeColors(value);
      return {
        themeColors: isDefaultBrandColors(colors)
          ? Prisma.DbNull
          : (colors as Prisma.InputJsonValue),
      };
    },
  },
  {
    key: "admin.workspaceName",
    group: GROUP.branding,
    label: "Workspace name",
    description:
      "Name this instance shows: the sidebar wordmark, the browser title, the installed app, shared chats and calendar exports. Up to 40 characters. Empty shows the built-in name.",
    columns: ["workspaceName"],
    apply: "none",
    scope: "admin",
    schema: z
      .string()
      .trim()
      .max(MAX_WORKSPACE_NAME_LENGTH, `Use ${MAX_WORKSPACE_NAME_LENGTH} characters or fewer.`),
    read: (row) => row.workspaceName,
    write: (_row, value) => ({ workspaceName: typeof value === "string" ? value.trim() : "" }),
  },
  {
    key: "admin.brandingAvatar",
    group: GROUP.branding,
    label: "Agent avatar",
    description:
      "File name of the uploaded agent avatar, set by the admin branding page. Without one, the built-in accent mark is drawn.",
    columns: ["brandingAvatar"],
    apply: "none",
    scope: "admin",
    schema: z
      .string()
      .refine(
        (value) => value === "" || isBrandingAvatarName(value),
        "Use the file name the upload route returned, or an empty string to fall back to the built-in mark.",
      ),
    read: (row) => row.brandingAvatar,
    write: (_row, value) => ({ brandingAvatar: value === null ? "" : String(value).trim() }),
  },
  {
    key: "admin.webSearchEngines",
    group: GROUP.admin,
    label: "Search engines",
    description:
      "Engines a web search may use, by their SearXNG name. An empty list allows every engine the instance runs.",
    columns: ["webSearchEngines"],
    apply: "none",
    scope: "admin",
    schema: z.array(z.string()),
    read: (row) => row.webSearchEngines,
    write: (_row, value) => ({
      webSearchEngines: Array.isArray(value) ? value.map(String) : [],
    }),
  },
  {
    key: "admin.webSearchCategories",
    group: GROUP.admin,
    label: "Search categories",
    description:
      'Categories a search draws from when it names no engine, such as "general" or "news".',
    columns: ["webSearchCategories"],
    apply: "none",
    scope: "admin",
    schema: z.array(z.string()),
    read: (row) => row.webSearchCategories,
    write: (_row, value) => ({
      webSearchCategories: Array.isArray(value) ? value.map(String) : [],
    }),
  },
  {
    key: "admin.webSearchSafeSearch",
    group: GROUP.admin,
    label: "Safe search",
    description: "How much adult content a search filters. 0 off, 1 moderate, 2 strict.",
    columns: ["webSearchSafeSearch"],
    apply: "none",
    scope: "admin",
    schema: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    read: (row) => safeSearchLevel(row.webSearchSafeSearch),
    write: (_row, value) => {
      const level = typeof value === "number" ? safeSearchLevel(value) : 0;
      return { webSearchSafeSearch: level };
    },
  },
  {
    key: "admin.webSearchLanguage",
    group: GROUP.admin,
    label: "Search language",
    description: 'Language code a search asks in, such as "en", "de" or "all".',
    columns: ["webSearchLanguage"],
    apply: "none",
    scope: "admin",
    schema: z.string().min(1),
    read: (row) => row.webSearchLanguage,
    write: (_row, value) => ({ webSearchLanguage: value === null ? "all" : String(value).trim() }),
  },
  {
    key: "admin.webSearchResultsPerCall",
    group: GROUP.admin,
    label: "Results per search",
    description: `How many results one search returns when the model asks for no number. 1 to ${MAX_RESULTS_PER_CALL}.`,
    columns: ["webSearchResultsPerCall"],
    apply: "none",
    scope: "admin",
    schema: z.number().int().min(1).max(MAX_RESULTS_PER_CALL),
    read: (row) => row.webSearchResultsPerCall,
    write: (_row, value) => ({
      webSearchResultsPerCall: clampSetting(
        Number(value ?? DEFAULT_RESULTS_PER_CALL),
        1,
        MAX_RESULTS_PER_CALL,
        DEFAULT_RESULTS_PER_CALL,
      ),
    }),
  },
  {
    key: "admin.webFetchMaxChars",
    group: GROUP.admin,
    label: "Fetched page length",
    description: `How many characters a fetched page is cut to. ${MIN_MAX_CHARS} to ${MAX_MAX_CHARS}.`,
    columns: ["webFetchMaxChars"],
    apply: "none",
    scope: "admin",
    schema: z.number().int().min(MIN_MAX_CHARS).max(MAX_MAX_CHARS),
    read: (row) => row.webFetchMaxChars,
    write: (_row, value) => ({
      webFetchMaxChars: clampSetting(
        Number(value ?? DEFAULT_MAX_CHARS),
        MIN_MAX_CHARS,
        MAX_MAX_CHARS,
        DEFAULT_MAX_CHARS,
      ),
    }),
  },
  {
    key: "admin.webFetchTimeoutMs",
    group: GROUP.admin,
    label: "Fetch timeout",
    description: `How many milliseconds a page fetch may take. ${MIN_FETCH_TIMEOUT_MS} to ${MAX_FETCH_TIMEOUT_MS}.`,
    columns: ["webFetchTimeoutMs"],
    apply: "none",
    scope: "admin",
    schema: z.number().int().min(MIN_FETCH_TIMEOUT_MS).max(MAX_FETCH_TIMEOUT_MS),
    read: (row) => row.webFetchTimeoutMs,
    write: (_row, value) => ({
      webFetchTimeoutMs: clampSetting(
        Number(value ?? DEFAULT_FETCH_TIMEOUT_MS),
        MIN_FETCH_TIMEOUT_MS,
        MAX_FETCH_TIMEOUT_MS,
        DEFAULT_FETCH_TIMEOUT_MS,
      ),
    }),
  },
  {
    key: "admin.webFetchMaxRedirects",
    group: GROUP.admin,
    label: "Fetch redirects",
    description: `How many redirects a page fetch follows before it gives up. 0 to ${MAX_MAX_REDIRECTS}.`,
    columns: ["webFetchMaxRedirects"],
    apply: "none",
    scope: "admin",
    schema: z.number().int().min(0).max(MAX_MAX_REDIRECTS),
    read: (row) => row.webFetchMaxRedirects,
    write: (_row, value) => ({
      webFetchMaxRedirects: clampSetting(
        Number(value ?? DEFAULT_MAX_REDIRECTS),
        0,
        MAX_MAX_REDIRECTS,
        DEFAULT_MAX_REDIRECTS,
      ),
    }),
  },
  {
    key: "admin.voiceEnabled",
    group: GROUP.admin,
    label: "Voice input",
    description: "Offer speech input in the composer. VOICE_URL names the transcription server.",
    columns: ["voiceEnabled"],
    apply: "none",
    scope: "admin",
    schema: z.boolean(),
    read: (row) => row.voiceEnabled,
    write: (_row, value) => ({ voiceEnabled: Boolean(value) }),
  },
  {
    key: "admin.voiceModel",
    group: GROUP.admin,
    label: "Voice model",
    description:
      "The faster-whisper model a transcription names. Null uses VOICE_MODEL, then the built-in small model.",
    columns: ["voiceModel"],
    apply: "none",
    scope: "admin",
    schema: z.string().min(1),
    read: (row) => row.voiceModel,
    write: (_row, value) => ({ voiceModel: value === null ? null : String(value).trim() || null }),
  },
  {
    key: "admin.voiceLanguage",
    group: GROUP.admin,
    label: "Voice language",
    description:
      "The language code recordings are decoded as. Null uses VOICE_LANGUAGE, then the server's own detection.",
    columns: ["voiceLanguage"],
    apply: "none",
    scope: "admin",
    schema: z.string().min(1),
    read: (row) => row.voiceLanguage,
    write: (_row, value) => ({
      voiceLanguage: value === null ? null : String(value).trim() || null,
    }),
  },
];

// ─── Registry ────────────────────────────────────────────────────────────────

export const USER_PROPERTIES: readonly UserProperty[] = [
  ...SCALAR_PROPERTIES,
  ...purposeProperties(),
  ...categoryEnabledProperties(),
  ...categoryExposureProperties(),
  ...toolPolicyProperties(),
  APPROVAL_DECISION_MODEL_PROPERTY,
  ...coderCategoryProperties(),
  ...sidebarProperties(),
  ...notificationProperties(),
];

export const ADMIN_PROPERTIES: readonly AdminProperty[] = ADMIN_PROPERTY_DEFINITIONS;

export const ALL_PROPERTIES: readonly Property[] = [...USER_PROPERTIES, ...ADMIN_PROPERTIES];

const PROPERTIES_BY_KEY = new Map<string, Property>(
  ALL_PROPERTIES.map((property) => [property.key, property]),
);

/** A property by its dotted key, from either scope. */
export function findProperty(key: string): Property | undefined {
  return PROPERTIES_BY_KEY.get(key);
}

/**
 * Every column the registry can write, per scope.
 *
 * This is the whitelist a settings patch is filtered against: a column no
 * property owns is not a setting, and is ignored.
 */
export function coveredColumns(scope: PropertyScope): string[] {
  const properties: readonly Property[] = scope === "user" ? USER_PROPERTIES : ADMIN_PROPERTIES;
  return [...new Set(properties.flatMap((property) => property.columns))];
}

/** Properties that own any of the given columns. */
export function propertiesForColumns(scope: "user", columns: Iterable<string>): UserProperty[];
export function propertiesForColumns(scope: "admin", columns: Iterable<string>): AdminProperty[];
export function propertiesForColumns(scope: PropertyScope, columns: Iterable<string>): Property[];
export function propertiesForColumns(scope: PropertyScope, columns: Iterable<string>): Property[] {
  const wanted = new Set(columns);
  const properties: readonly Property[] = scope === "user" ? USER_PROPERTIES : ADMIN_PROPERTIES;
  return properties.filter((property) => property.columns.some((column) => wanted.has(column)));
}
