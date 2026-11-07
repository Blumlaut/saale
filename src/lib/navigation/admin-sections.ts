/**
 * Admin areas that hold more than one page.
 *
 * The sections of an admin nav item, in display order. They live in the sidebar
 * (and in the phone section picker) instead of a tab strip above the content, so
 * the item a page belongs to expands into them.
 */

import { hasGrant, type RolePermissions } from "@/lib/permissions/roles";
import type { AdminAction } from "@/lib/permissions/statements";

export interface AdminSection {
  id: string;
  href: string;
  label: string;
  /** One line explaining the page, for the phone section picker. */
  description: string;
  /** The admin slice this section needs, when it has one of its own. */
  action?: AdminAction;
}

export const ADMIN_SECTIONS: Readonly<Record<string, readonly AdminSection[]>> = {
  "/admin/users": [
    {
      id: "accounts",
      href: "/admin/users/accounts",
      label: "Accounts",
      description: "Who can sign in, and what each account may do",
      action: "users",
    },
    {
      id: "workspaces",
      href: "/admin/users/workspaces",
      label: "Workspaces",
      description: "Disk usage and what each workspace is running",
      action: "workspaces",
    },
    {
      id: "usage",
      href: "/admin/users/usage",
      label: "Usage",
      description: "What each account's model calls cost, and who paid",
      action: "usage",
    },
  ],
  "/admin/models": [
    {
      id: "providers",
      href: "/admin/models/providers",
      label: "API providers",
      description: "Endpoints, keys and per-model limits",
    },
    {
      id: "availability",
      href: "/admin/models/availability",
      label: "Models",
      description: "The default model and which models users can pick",
    },
  ],
  "/admin/settings": [
    {
      id: "signups",
      href: "/admin/settings/signups",
      label: "Sign-ups",
      description: "Whether new accounts can be created",
    },
    {
      id: "sso",
      href: "/admin/settings/sso",
      label: "Single sign-on",
      description: "The identity provider and the redirect URI to register",
    },
    {
      id: "mail",
      href: "/admin/settings/mail",
      label: "Mail",
      description: "The relay verification and reset mail goes out through",
    },
    {
      id: "features",
      href: "/admin/settings/features",
      label: "Features",
      description: "What a regular account can use by default",
      action: "settings",
    },
    {
      id: "shared-mcp",
      href: "/admin/settings/shared-mcp",
      label: "MCP servers",
      description: "MCP servers every account connects",
      action: "settings",
    },
    {
      id: "shared-prompts",
      href: "/admin/settings/shared-prompts",
      label: "Prompts",
      description: "Slash commands every account can send",
      action: "settings",
    },
    {
      id: "coder",
      href: "/admin/settings/coder",
      label: "Coder",
      description: "The trailer every coder commit ends with",
      action: "settings",
    },
    {
      id: "branding",
      href: "/admin/settings/branding",
      label: "Branding",
      description: "The agent avatar and the accent colours",
    },
    {
      id: "telegram",
      href: "/admin/settings/telegram",
      label: "Telegram",
      description: "The bot accounts link to and chat through",
    },
    {
      id: "search",
      href: "/admin/settings/search",
      label: "Search",
      description: "The search sources and the page fetch budget",
    },
    {
      id: "voice",
      href: "/admin/settings/voice",
      label: "Voice",
      description: "Speech input, with the model and language it decodes",
    },
  ],
  "/admin/plugins": [
    {
      id: "installed",
      href: "/admin/plugins/installed",
      label: "Installed",
      description: "What is running and what it may do",
    },
    {
      id: "configuration",
      href: "/admin/plugins/configuration",
      label: "Configuration",
      description: "Plugin directory and global switches",
    },
    {
      id: "logs",
      href: "/admin/plugins/logs",
      label: "Logs",
      description: "What the plugins reported",
    },
  ],
};

/** The sections of an admin item, empty when it is a single page. */
export function adminSections(itemHref: string): readonly AdminSection[] {
  return ADMIN_SECTIONS[itemHref] ?? [];
}

/** The sections the account may open. A section without an action is always shown. */
export function visibleAdminSections(
  itemHref: string,
  permissions: RolePermissions,
): readonly AdminSection[] {
  return adminSections(itemHref).filter(
    (section) => !section.action || hasGrant(permissions, "admin", section.action),
  );
}

/**
 * Whether the account may open an admin item: its own slice, or one of the
 * sections that stands on a slice of its own.
 */
export function canOpenAdminItem(
  itemHref: string,
  action: AdminAction,
  permissions: RolePermissions,
): boolean {
  return (
    hasGrant(permissions, "admin", action) || visibleAdminSections(itemHref, permissions).length > 0
  );
}

/** Whether a pathname belongs to an admin item's route (or one of its sections). */
export function isAdminItemPath(itemHref: string, pathname: string): boolean {
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`);
}

/**
 * The section a pathname is in, or null when it is in none of them.
 *
 * The longest match wins: `/admin/users` is a prefix of every section under it,
 * and it must not answer for `/admin/users/workspaces`.
 */
export function matchAdminSection<T extends { href: string }>(
  sections: readonly T[],
  pathname: string,
): T | null {
  let best: T | null = null;
  for (const section of sections) {
    if (!isAdminItemPath(section.href, pathname)) continue;
    if (!best || section.href.length > best.href.length) best = section;
  }
  return best;
}
