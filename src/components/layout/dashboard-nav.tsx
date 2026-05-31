"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { MessageSquare, Mail, ListTodo, Settings, ChevronRight, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

const navItems = [
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/mail", label: "Mail", icon: Mail },
  { href: "/dashboard/tasks", label: "Tasks", icon: ListTodo },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardNav() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  return (
    <nav className="sticky top-6 h-fit w-56 shrink-0">
      <GlassPanel className="shadow-md">
        <GlassPanelContent className="p-3">
          {/* Brand */}
          <Link href="/dashboard" className="mb-1 flex items-center gap-2 px-3 py-2">
            <ChevronRight className="text-primary h-5 w-5" />
            <span className="text-lg font-bold tracking-tight">Saale</span>
          </Link>

          <Separator className="my-2" />

          {/* Nav Items */}
          <div className="space-y-0.5">
            {navItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                    isActive
                      ? "bg-white/20 font-medium dark:bg-white/5"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/10",
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

      {/* Theme toggle + version */}
      <div className="mt-4 flex items-center justify-between px-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-lg"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label="Toggle theme"
        >
          <Sun className="h-4 w-4 dark:hidden" />
          <Moon className="hidden h-4 w-4 dark:block" />
        </Button>
        <p className="text-muted-foreground text-xs">v0.1.0</p>
      </div>
    </nav>
  );
}
