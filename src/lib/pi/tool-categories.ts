/**
 * Tool category metadata — single source of truth.
 *
 * Every tool category is declared here with its display metadata.
 * - `ToolConfig` type is derived from this array
 * - `DEFAULT_TOOL_CONFIG` is derived from this array
 * - UI components (settings, input bar) derive labels from this array
 * - `tool-registry.ts` maps categories to their tool factories
 *
 * Add a new category here and everything else picks it up automatically.
 */

import type { LucideIcon } from "lucide-react";
import {
  Terminal,
  Mail,
  ListTodo,
  Calendar,
  History,
  Globe,
  Brain,
  CheckSquare,
  Bot,
  Server,
} from "lucide-react";

export interface ToolCategory {
  /** Unique key — matches ToolConfig property name */
  key: string;
  /** Display name shown in UI toggles */
  label: string;
  /** One-line description shown in settings */
  description: string;
  /** Icon shown in tool category selectors */
  icon: LucideIcon;
  /** Enabled by default for new users */
  defaultEnabled: boolean;
  /** How the category's tools reach the model unless the user changes it. */
  defaultExposure: ToolExposure;
}

/**
 * Registry of all tool categories.
 * Source of truth — types, defaults, and UI all derive from here.
 */
export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    key: "terminal",
    label: "Terminal",
    description: "Run commands and manage files in a sandboxed workspace",
    icon: Terminal,
    defaultEnabled: false,
    // The core working tools: always declared, the model must reach for them
    // without a discovery step.
    defaultExposure: "direct",
  },
  {
    key: "email",
    label: "Email",
    description: "Access and manage email accounts",
    icon: Mail,
    defaultEnabled: true,
    defaultExposure: "codemode",
  },
  {
    key: "jobs",
    label: "Jobs",
    description: "Manage scheduled background jobs",
    icon: ListTodo,
    defaultEnabled: true,
    defaultExposure: "codemode",
  },
  {
    key: "calendar",
    label: "Calendar",
    description: "Access and manage calendar events",
    icon: Calendar,
    defaultEnabled: true,
    defaultExposure: "codemode",
  },
  {
    key: "chatSearch",
    label: "Chat history",
    description: "Search, respond in, and delete conversations",
    icon: History,
    defaultEnabled: true,
    defaultExposure: "codemode",
  },
  {
    key: "web",
    label: "Web",
    description: "Search and fetch web content",
    icon: Globe,
    defaultEnabled: true,
    defaultExposure: "direct",
  },
  {
    key: "memory",
    label: "Memory",
    description: "Search persistent AI memories",
    icon: Brain,
    defaultEnabled: true,
    defaultExposure: "direct",
  },
  {
    key: "tasks",
    label: "Tasks",
    description: "Create and manage tasks and to-dos",
    icon: CheckSquare,
    defaultEnabled: true,
    defaultExposure: "codemode",
  },
  {
    key: "agentJobs",
    label: "Agent jobs",
    description: "Manage custom agent job definitions and runs",
    icon: Bot,
    defaultEnabled: true,
    defaultExposure: "codemode",
  },
  {
    key: "infra",
    label: "Infrastructure",
    description: "Manage remote machines via SSH",
    icon: Server,
    defaultEnabled: false,
    defaultExposure: "codemode",
  },
];

/**
 * Derive the ToolConfig type from the category registry.
 * This ensures the config type is always in sync with the categories.
 */
export type ToolCategoryKey = (typeof TOOL_CATEGORIES)[number]["key"];
export type ToolConfig = Partial<Record<ToolCategoryKey, boolean>>;

/**
 * Derive the default tool config from the category registry.
 */
export const DEFAULT_TOOL_CONFIG: Record<ToolCategoryKey, boolean> = Object.fromEntries(
  TOOL_CATEGORIES.map((c) => [c.key, c.defaultEnabled]),
) as Record<ToolCategoryKey, boolean>;

/**
 * How a category's tools reach the model.
 *
 * - `direct` — declared to the model and callable by name. Costs context on
 *   every request, whether or not the tools are used.
 * - `codemode` — not declared; listed in the `codemode` tool's catalog and
 *   callable from a script. Costs context only through that catalog (bounded
 *   by codemode's inline budget) and the approval gate still applies.
 * - `deferred` — not declared and not listed; codemode scripts find it with
 *   `searchTools()`. Costs no context until the model looks for it.
 */
export type ToolExposure = "direct" | "codemode" | "deferred";

/** Per-category exposure. Sparse — an absent key means the category default. */
export type ToolExposureConfig = Partial<Record<ToolCategoryKey, ToolExposure>>;

/**
 * Exposure used for a category the user has not changed.
 *
 * Saale hides the niche tool sets behind codemode by default: a chat that only
 * needs memory and the web should not pay for the email, jobs, calendar and
 * infra catalogs on every request. The three `direct` categories are the ones
 * an ordinary conversation reaches for most — flipping them to codemode would
 * make the common case slower (a script per lookup) to save context it uses.
 */
export const DEFAULT_TOOL_EXPOSURE: Record<ToolCategoryKey, ToolExposure> = Object.fromEntries(
  TOOL_CATEGORIES.map((c) => [c.key, c.defaultExposure]),
) as Record<ToolCategoryKey, ToolExposure>;

/** Display metadata for the exposure selector, in preference order. */
export const TOOL_EXPOSURES: Array<{
  value: ToolExposure;
  label: string;
  description: string;
}> = [
  {
    value: "direct",
    label: "Always available",
    description: "The model sees these tools on every request.",
  },
  {
    value: "codemode",
    label: "Via codemode",
    description: "Hidden from the model; reachable by writing a script that calls them.",
  },
  {
    value: "deferred",
    label: "Search only",
    description: "Hidden entirely; found by searching from a codemode script.",
  },
];

/** Whether a value is a known exposure. */
export function isToolExposure(value: unknown): value is ToolExposure {
  return value === "direct" || value === "codemode" || value === "deferred";
}

/**
 * Look up a category by key.
 */
export function getToolCategory(key: string): ToolCategory | undefined {
  return TOOL_CATEGORIES.find((c) => c.key === key);
}
