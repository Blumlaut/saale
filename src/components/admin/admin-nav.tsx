"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useSessionPermissions } from "@/hooks/use-session-permissions";
import { hasGrant } from "@/lib/permissions/roles";
import type { AdminAction } from "@/lib/permissions/statements";
import { Bot, Users, Settings, KeyRound, ArrowLeft, Puzzle, type LucideIcon } from "lucide-react";
import { adminSections, isAdminItemPath } from "@/lib/navigation/admin-sections";
import {
  SidebarBrand,
  SidebarFooter,
  SidebarFrame,
  SidebarItem,
  SidebarSectionList,
  SidebarSections,
  SidebarSectionToggle,
  sidebarItemClass,
} from "@/components/layout/sidebar-chrome";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The admin slice the page needs; a role without it never sees the item. */
  action: AdminAction;
}

/** The admin panel's nav items. shared by the desktop sidebar and the mobile bottom bar. */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { href: "/admin/models", label: "Models", icon: Bot, action: "models" },
  { href: "/admin/users", label: "Users", icon: Users, action: "users" },
  { href: "/admin/roles", label: "Roles", icon: KeyRound, action: "roles" },
  { href: "/admin/plugins", label: "Plugins", icon: Puzzle, action: "plugins" },
  { href: "/admin/settings", label: "Settings", icon: Settings, action: "settings" },
];

/**
 * The admin sidebar. Same frame, rows and footer as the dashboard's: only the
 * items and the badge differ.
 */
export function AdminNav() {
  const pathname = usePathname();
  const access = useSessionPermissions();
  const items = access
    ? ADMIN_NAV_ITEMS.filter((item) => hasGrant(access.permissions, "admin", item.action))
    : [];

  // One item's sections are open at a time: the area you are in opens them, and
  // leaving closes them again.
  const [expandedHref, setExpandedHref] = useState<string | null>(null);
  const areaHref =
    ADMIN_NAV_ITEMS.find(
      (item) => adminSections(item.href).length > 0 && isAdminItemPath(item.href, pathname),
    )?.href ?? null;

  useEffect(() => {
    setExpandedHref(areaHref);
  }, [areaHref]);

  return (
    <SidebarFrame>
      <SidebarBrand badge="Admin" />

      <div className="space-y-0.5">
        {items.map((item) => {
          const sections = adminSections(item.href);
          const expanded = expandedHref === item.href;
          const activeId = sections.find(
            (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
          )?.id;

          return (
            <div key={item.href}>
              <SidebarItem
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isAdminItemPath(item.href, pathname)}
                trailing={
                  sections.length > 0 ? (
                    <SidebarSectionToggle
                      label={item.label}
                      expanded={expanded}
                      onToggle={() => setExpandedHref(expanded ? null : item.href)}
                    />
                  ) : undefined
                }
              />
              {sections.length > 0 ? (
                <SidebarSections open={expanded}>
                  <SidebarSectionList
                    groups={[{ label: null, items: sections }]}
                    activeId={activeId}
                  />
                </SidebarSections>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Back to the app, in the same shape as the items above it */}
      <div className="border-border/60 mt-3 border-t pt-2">
        <Link href="/dashboard/chat" className={sidebarItemClass(false)}>
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span className="truncate">Back to app</span>
        </Link>
      </div>

      <SidebarFooter />
    </SidebarFrame>
  );
}
