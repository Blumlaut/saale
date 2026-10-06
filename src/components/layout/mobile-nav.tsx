"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useSidebarNav } from "@/components/providers/sidebar-nav-provider";
import { SIDEBAR_NAV_ICONS } from "@/components/layout/sidebar-nav-icons";
import { isSidebarNavActive } from "@/lib/navigation/sidebar-nav";

export function MobileNav() {
  const pathname = usePathname();
  const { visibleItems } = useSidebarNav();

  return (
    <nav className="border-border bg-card fixed inset-x-0 bottom-0 z-40 border-t md:hidden">
      {/* flex-1 + min-w-0 keeps every item on a 320px screen; truncate is a safety net */}
      <div className="flex h-14 items-center px-1">
        {visibleItems.map((item) => {
          const isActive = isSidebarNavActive(item.href, pathname);
          const Icon = SIDEBAR_NAV_ICONS[item.id];

          return (
            <Link
              key={item.id}
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
                {item.mobileLabel ?? item.label}
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
