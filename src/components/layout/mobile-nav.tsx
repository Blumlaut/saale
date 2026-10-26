"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Home, Shield, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebarNav } from "@/components/providers/sidebar-nav-provider";
import { SIDEBAR_NAV_ICONS } from "@/components/layout/sidebar-nav-icons";
import { ADMIN_NAV_ITEMS } from "@/components/admin/admin-nav";
import { useSessionPermissions } from "@/hooks/use-session-permissions";
import { hasGrant } from "@/lib/permissions/roles";

interface MobileNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

function isItemActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The mobile bottom bar. On app pages it mirrors the user's sidebar layout
 * (admins get the Admin item appended); inside the admin panel it mirrors the
 * admin sidebar and swaps in a Dashboard item as the way back to the app.
 */
export function MobileNav() {
  const pathname = usePathname();
  const { visibleItems } = useSidebarNav();
  const access = useSessionPermissions();
  const isAdmin = access ? hasGrant(access.permissions, "admin", "access") : false;
  const inAdminPanel = pathname.startsWith("/admin");

  const adminItems = access
    ? ADMIN_NAV_ITEMS.filter((item) => hasGrant(access.permissions, "admin", item.action))
    : [];

  const items: MobileNavItem[] = inAdminPanel
    ? [
        ...adminItems.map(({ href, label, icon }) => ({ href, label, icon })),
        { href: "/dashboard/chat", label: "Dashboard", icon: Home },
      ]
    : [
        ...visibleItems.map((item) => ({
          href: item.href,
          label: item.mobileLabel ?? item.label,
          icon: SIDEBAR_NAV_ICONS[item.id],
        })),
        ...(isAdmin ? [{ href: "/admin/models", label: "Admin", icon: Shield }] : []),
      ];

  return (
    <nav className="mobile-nav border-border bg-card fixed inset-x-0 bottom-0 z-40 border-t md:hidden">
      {/* flex-1 + min-w-0 keeps every item on a 320px screen; truncate is a safety net */}
      <div className="flex h-14 items-center px-1">
        {items.map((item) => {
          const isActive = isItemActive(item.href, pathname);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-0.5 py-1.5 transition-colors",
                isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "h-5 w-5",
                  isActive ? "text-primary stroke-[2.5px]" : "stroke-[1.5px]",
                )}
              />
              <span
                className={cn(
                  "max-w-full truncate text-[10px] font-medium tracking-tight max-[360px]:text-[9px]",
                  isActive && "text-foreground",
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>
      {/* Safe area padding for devices with home indicator */}
      <div className="h-safe-area-inset-bottom" />
    </nav>
  );
}
