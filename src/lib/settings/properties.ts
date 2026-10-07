/**
 * Saale settings registry — the single source of truth for every configurable
 * value in `AppSettings` (per user) and `AdminSettings` (global).
 *
 * Everything that reads or writes a setting goes through here:
 *
 * - The agent's `settings_list` / `settings_set` tools address properties by
 *   their dotted key.
 * - The settings API routes apply column patches, which this module normalizes
 *   and validates property by property.
 *
 * Most of the registry is **derived** from registries that already exist — tool
 * categories, tool policies, model purposes, thinking levels and sidebar items
 * — so adding a tool category or a purpose needs no change here at all. Adding
 * a plain column to `AppSettings`/`AdminSettings` does need one entry (its
 * label, description and validation cannot be inferred). `__tests__` compares
 * this registry against `prisma/schema.prisma`, so a forgotten entry fails CI
 * instead of silently leaving the setting unreachable.
 *
 * Each property declares:
 * - `key`     — the dotted path the model uses (`tools.category.email.enabled`)
 * - `columns` — the row columns it owns (drives coverage tests and patches)
 * - `schema`  — validation for a set (`null` means "restore the default")
 * - `read` / `write` — pure projections in and out of the row
 * - `apply`   — `sessions` when a pooled agent session must be rebuilt
 *
 * Secrets never live in these tables, so nothing here is redacted.
 */

import { Prisma, type AdminSettings, type AppSettings } from "@prisma/client";
import { z } from "zod";
import {
  isDefaultSidebarNav,
  isSidebarNavPinned,
  normalizeSidebarNav,
  SIDEBAR_NAV_ITEMS,
  type SidebarNavEntry,
} from "@/lib/navigation/sidebar-nav";
import { formatModelReference, splitModelReference } from "@/lib/pi/model-ref";
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
import { ALL_TOOL_INFOS, type ToolPolicy } from "@/lib/pi/tool-infos";
import { getAllPurposes } from "@/lib/pi/purposes";
import { normalizeToolExposure } from "@/lib/pi/tool-exposure-rules";

// ─── Types ───────────────────────────────────────────────────────────────────

export type PropertyScope = "user" | "admin";

/**
 * What a change invalidates.
 *
 * - `none`     — read fresh on the next request / client render.
 * - `sessions` — baked into a pooled agent session (model, tools, exposure,
 *   system prompt), so the user's pooled sessions must be evicted to rebuild.
 */
export type PropertyApply = "none" | "sessions";

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

const THEMES = ["light", "dark", "system"] as const;

const THINKING_LEVEL_VALUES = THINKING_LEVEL_OPTIONS.map((option) => option.id);
const EXPOSURE_VALUES = TOOL_EXPOSURES.map((option) => option.value);
const POLICY_VALUES: readonly ToolPolicy[] = ["allow", "auto", "ask", "off"];

/** `provider:model` — the same form the settings UI stores. */
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
  sidebar: "sidebar",
  admin: "admin",
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
    description: 'Interface colour scheme: "light", "dark" or "system".',
    values: THEMES,
    columns: ["theme"],
    apply: "none",
    scope: "user",
    schema: z.enum(THEMES),
    read: (row) => row.theme,
    write: (_row, value) => ({
      theme: value === null ? THEMES[2] : String(value),
    }),
  },
  {
    key: "appearance.compactActivity",
    group: GROUP.appearance,
    label: "Compact activity",
    description:
      "Collapse a turn's reasoning and tool calls into one line each — a running tool count with the tools' own icons — instead of a card per step. Each line expands to the full detail. Set to false for the step-by-step transcript.",
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

/** `models.purpose.<id>` — a model override per AI purpose. */
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

/** `tools.category.<key>.enabled` — whether a category is on for new chats. */
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

/** `tools.category.<key>.exposure` — how a category's tools reach the model. */
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

/** `tools.policy.<tool>` — the approval policy for one tool. */
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

/**
 * `sidebar.<item>.hidden` — whether a navigation item is hidden.
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

const ADMIN_PROPERTY_DEFINITIONS: AdminProperty[] = [
  {
    key: "admin.signupsEnabled",
    group: GROUP.admin,
    label: "Sign-ups enabled",
    description: "Whether new accounts can be created on this Saale instance.",
    columns: ["signupsEnabled"],
    apply: "none",
    scope: "admin",
    schema: z.boolean(),
    read: (row) => row.signupsEnabled,
    write: (_row, value) => ({ signupsEnabled: Boolean(value) }),
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
];

// ─── Registry ────────────────────────────────────────────────────────────────

export const USER_PROPERTIES: readonly UserProperty[] = [
  ...SCALAR_PROPERTIES,
  ...purposeProperties(),
  ...categoryEnabledProperties(),
  ...categoryExposureProperties(),
  ...toolPolicyProperties(),
  ...sidebarProperties(),
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
