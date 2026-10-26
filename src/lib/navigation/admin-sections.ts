/**
 * Admin areas that hold more than one page.
 *
 * The sections of an admin nav item, in display order. They live in the sidebar
 * (and in the phone section picker) instead of a tab strip above the content, so
 * the item a page belongs to expands into them.
 */

export interface AdminSection {
  id: string;
  href: string;
  label: string;
  /** One line explaining the page, for the phone section picker. */
  description: string;
}

export const ADMIN_SECTIONS: Readonly<Record<string, readonly AdminSection[]>> = {
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

/** Whether a pathname belongs to an admin item's route (or one of its sections). */
export function isAdminItemPath(itemHref: string, pathname: string): boolean {
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`);
}
