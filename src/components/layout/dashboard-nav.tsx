"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { MessageSquare, Mail, ListTodo, Settings, ChevronRight } from "lucide-react";

const navItems = [
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/mail", label: "Mail", icon: Mail },
  { href: "/dashboard/tasks", label: "Tasks", icon: ListTodo },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <aside className="bg-muted/30 flex w-64 flex-col border-r">
      <div className="flex h-14 items-center px-4">
        <Link href="/dashboard/chat" className="flex items-center gap-2">
          <ChevronRight className="text-primary h-5 w-5" />
          <span className="text-lg font-bold tracking-tight">Saale</span>
        </Link>
      </div>

      <Separator />

      <nav className="flex-1 space-y-1 px-2 py-4">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "focus-visible:ring-ring inline-flex w-full items-center justify-start gap-2 rounded-lg px-3 py-2 text-sm font-normal transition-colors focus-visible:ring-2 focus-visible:outline-none",
                isActive ? "bg-muted font-medium" : "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-4">
        <p className="text-muted-foreground text-xs">v0.1.0</p>
      </div>
    </aside>
  );
}
