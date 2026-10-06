"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { ChevronRight, Bot, Users, Settings, ArrowLeft, type LucideIcon } from "lucide-react";

export interface AdminNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** The admin panel's nav items — shared by the desktop sidebar and the mobile bottom bar. */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { href: "/admin/models", label: "Models", icon: Bot },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();

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

          {/* Nav Items */}
          <div className="space-y-0.5">
            {ADMIN_NAV_ITEMS.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                    isActive
                      ? "bg-accent font-medium dark:bg-white/5"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/60",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
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
