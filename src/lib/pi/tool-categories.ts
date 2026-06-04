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
  FolderOpen,
  Mail,
  ListTodo,
  Calendar,
  History,
  Globe,
  Brain,
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
}

/**
 * Registry of all tool categories.
 * Source of truth — types, defaults, and UI all derive from here.
 */
export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    key: "bash",
    label: "Bash",
    description: "Run shell commands in a sandboxed workspace",
    icon: Terminal,
    defaultEnabled: false,
  },
  {
    key: "files",
    label: "Files",
    description: "Read, write, and edit files",
    icon: FolderOpen,
    defaultEnabled: true,
  },
  {
    key: "email",
    label: "Email",
    description: "Access and manage email accounts",
    icon: Mail,
    defaultEnabled: true,
  },
  {
    key: "jobs",
    label: "Jobs",
    description: "Manage scheduled background tasks",
    icon: ListTodo,
    defaultEnabled: true,
  },
  {
    key: "calendar",
    label: "Calendar",
    description: "Access and manage calendar events",
    icon: Calendar,
    defaultEnabled: true,
  },
  {
    key: "chatSearch",
    label: "Chat history",
    description: "Search through past conversations",
    icon: History,
    defaultEnabled: true,
  },
  {
    key: "web",
    label: "Web",
    description: "Search and fetch web content",
    icon: Globe,
    defaultEnabled: true,
  },
  {
    key: "memory",
    label: "Memory",
    description: "Search persistent AI memories",
    icon: Brain,
    defaultEnabled: true,
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
 * Look up a category by key.
 */
export function getToolCategory(key: string): ToolCategory | undefined {
  return TOOL_CATEGORIES.find((c) => c.key === key);
}
