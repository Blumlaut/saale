/**
 * Feature registry. every switchable module, with the strings and wiring that
 * describe it.
 *
 * Client-safe on purpose: the admin users/settings screens render these labels
 * and the tool registry and nav resolve their feature through this module, so a
 * feature is declared in exactly one place.
 */

import type { SidebarNavItemId } from "@/lib/navigation/sidebar-nav";
import type { ToolCategoryKey } from "@/lib/pi/tool-categories";

export interface FeatureDefinition {
  label: string;
  description: string;
  /** Tool categories the feature unlocks for the agent. */
  toolCategories: readonly ToolCategoryKey[];
  /** Dashboard nav item the feature unlocks. */
  navId?: SidebarNavItemId;
  /** Granted to regular accounts until an admin says otherwise. */
  defaultOn: boolean;
}

export const FEATURES = [
  "mail",
  "calendar",
  "tasks",
  "jobs",
  "council",
  "infra",
  "mcp",
  "watchers",
  "terminal",
  "telegram",
  "web",
  "memory",
  "chatSearch",
  "agentJobs",
  "coder",
] as const;

export type FeatureKey = (typeof FEATURES)[number];

export const FEATURE_DEFINITIONS: Record<FeatureKey, FeatureDefinition> = {
  coder: {
    label: "Coder",
    description: "Project worktrees and coding chats, with the terminal and file tools.",
    toolCategories: ["terminal"],
    navId: "coder",
    defaultOn: true,
  },
  mail: {
    label: "Mail",
    description: "Inbox, contacts and the assistant's email tools.",
    toolCategories: ["email", "contacts"],
    navId: "mail",
    defaultOn: true,
  },
  calendar: {
    label: "Calendar",
    description: "Events and invites, in the app and as tools.",
    toolCategories: ["calendar"],
    navId: "calendar",
    defaultOn: true,
  },
  tasks: {
    label: "Tasks",
    description: "Tasks and to-dos, in the app and as tools.",
    toolCategories: ["tasks"],
    navId: "tasks",
    defaultOn: true,
  },
  jobs: {
    label: "Jobs",
    description: "Scheduled background jobs.",
    toolCategories: ["jobs"],
    navId: "jobs",
    defaultOn: true,
  },
  // Costs several models at a time and shares a workspace between them, so it
  // stays off until an admin turns it on for an account.
  council: {
    label: "Council",
    description: "Run several models against one brief, in a shared room.",
    toolCategories: [],
    navId: "council",
    defaultOn: false,
  },
  infra: {
    label: "Infrastructure",
    description: "Remote machines reached over SSH, and their notes.",
    toolCategories: ["infra"],
    navId: "infra",
    defaultOn: true,
  },
  mcp: {
    label: "MCP servers",
    description: "The user's own MCP servers, connected to chat sessions.",
    toolCategories: [],
    defaultOn: true,
  },
  watchers: {
    label: "Watchers",
    description: "Poll a condition and wake the assistant when it matches.",
    toolCategories: ["watchers"],
    defaultOn: true,
  },
  terminal: {
    label: "Terminal",
    description: "Shell and file tools inside the sandbox.",
    toolCategories: ["terminal"],
    defaultOn: true,
  },
  telegram: {
    label: "Telegram",
    description: "Reach the user on Telegram between conversations.",
    toolCategories: ["telegram"],
    defaultOn: true,
  },
  web: {
    label: "Web",
    description: "Web search and page fetching.",
    toolCategories: ["web"],
    defaultOn: true,
  },
  memory: {
    label: "Memory",
    description: "Persistent memories the assistant can search and update.",
    toolCategories: ["memory"],
    defaultOn: true,
  },
  chatSearch: {
    label: "Chat history",
    description: "Search, respond in and manage conversations from a tool.",
    toolCategories: ["chatSearch"],
    defaultOn: true,
  },
  agentJobs: {
    label: "Agent jobs",
    description: "Job definitions and runs the assistant schedules itself.",
    toolCategories: ["agentJobs"],
    defaultOn: true,
  },
};

/** Per-account feature switches. Absent = follow the instance default. */
export type FeatureOverrides = Partial<Record<FeatureKey, boolean>>;
export type FeatureMap = Record<FeatureKey, boolean>;

/** The out-of-the-box feature set, before any admin choice. */
export function defaultFeatures(): FeatureMap {
  const out = {} as FeatureMap;
  for (const key of FEATURES) out[key] = FEATURE_DEFINITIONS[key].defaultOn;
  return out;
}

/** Every feature on. what an admin account always gets. */
export function allFeatures(): FeatureMap {
  const out = {} as FeatureMap;
  for (const key of FEATURES) out[key] = true;
  return out;
}

/** Drop unknown keys and non-boolean values from a stored override map. */
export function normalizeFeatureOverrides(value: unknown): FeatureOverrides {
  const out: FeatureOverrides = {};
  if (typeof value !== "object" || value === null) return out;
  for (const key of FEATURES) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

/** The feature that unlocks a tool category, if any. */
export function featureForToolCategory(category: ToolCategoryKey | string): FeatureKey | undefined {
  return FEATURES.find((key) =>
    FEATURE_DEFINITIONS[key].toolCategories.includes(category as ToolCategoryKey),
  );
}
