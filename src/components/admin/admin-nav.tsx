"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { useSessionPermissions } from "@/hooks/use-session-permissions";
import { hasGrant } from "@/lib/permissions/roles";
import type { AdminAction } from "@/lib/permissions/statements";
import {
  ChevronRight,
  ChevronDown,
  Bot,
  Users,
  Settings,
  KeyRound,
  ArrowLeft,
  Puzzle,
  type LucideIcon,
} from "lucide-react";
import { adminSections, isAdminItemPath } from "@/lib/navigation/admin-sections";

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

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();
  const access = useSessionPermissions();
  const items = access
    ? ADMIN_NAV_ITEMS.filter((item) => hasGrant(access.permissions, "admin", item.action))
    : [];

  // One item's sections are open at a time, and the page you are on opens its own.
  const [expandedHref, setExpandedHref] = useState<string | null>(null);
  const ownItem = ADMIN_NAV_ITEMS.find((item) => isAdminItemPath(item.href, pathname));

  useEffect(() => {
    if (ownItem && adminSections(ownItem.href).length > 0) setExpandedHref(ownItem.href);
  }, [ownItem]);

  return (
    <nav className="sidebar-nav sticky top-6 h-fit w-56 shrink-0">
      <GlassPanel className="shadow-md">
        <GlassPanelContent className="p-3">
          {/* Brand */}
          <div className="mb-1 flex items-center justify-between px-3 py-2">
            <Link href="/dashboard/chat" className="flex items-center gap-2">
              <ChevronRight className="text-primary h-5 w-5" />
              <span className="text-lg font-bold tracking-tight">Saale</span>
            </Link>
            <span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[10px] font-medium dark:bg-white/5">
              Admin
            </span>
          </div>

          <Separator className="my-2" />

          {/* Nav Items. an item with sections expands into them */}
          <div className="space-y-0.5">
            {items.map((item) => {
              const isActive = isAdminItemPath(item.href, pathname);
              const Icon = item.icon;
              const sections = adminSections(item.href);
              const expanded = expandedHref === item.href;

              return (
                <div key={item.href}>
                  <div className="flex items-center gap-1">
                    <Link
                      href={item.href}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                        isActive
                          ? "bg-accent font-medium dark:bg-white/5"
                          : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Link>
                    {sections.length > 0 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground size-7 shrink-0 rounded-md"
                        aria-expanded={expanded}
                        aria-label={
                          expanded ? `Hide ${item.label} pages` : `Show ${item.label} pages`
                        }
                        onClick={() => setExpandedHref(expanded ? null : item.href)}
                      >
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 transition-transform duration-150",
                            !expanded && "-rotate-90",
                          )}
                        />
                      </Button>
                    )}
                  </div>

                  {sections.length > 0 && expanded && (
                    <div className="border-border/60 mt-0.5 ml-3.5 border-l pl-1.5">
                      {sections.map((section) => {
                        const sectionActive =
                          pathname === section.href || pathname.startsWith(`${section.href}/`);

                        return (
                          <Link
                            key={section.id}
                            href={section.href}
                            aria-current={sectionActive ? "page" : undefined}
                            className={cn(
                              "flex items-center rounded-lg px-2 py-0.5 text-sm transition-colors duration-150",
                              sectionActive
                                ? "bg-accent text-foreground font-medium"
                                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                            )}
                          >
                            <span className="truncate">{section.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </GlassPanelContent>
      </GlassPanel>

      {/* Back to app */}
      <div className="mt-4 px-3">
        <Button
          variant="ghost"
          className="text-muted-foreground w-full justify-start gap-2"
          onClick={() => router.push("/dashboard/chat")}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to app
        </Button>
      </div>
    </nav>
  );
}
