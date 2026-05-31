"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
    <aside className="flex w-64 flex-col border-r bg-muted/30">
      <div className="flex h-14 items-center px-4">
        <Link href="/dashboard/chat" className="flex items-center gap-2">
          <ChevronRight className="h-5 w-5 text-primary" />
          <span className="text-lg font-bold tracking-tight">Saale</span>
        </Link>
      </div>

      <Separator />

      <nav className="flex-1 space-y-1 px-2 py-4">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;

          return (
            <Button
              key={item.href}
              variant={isActive ? "secondary" : "ghost"}
              className={cn(
                "w-full justify-start gap-2 font-normal",
                isActive && "bg-muted font-medium",
              )}
              asChild
            >
              <Link href={item.href}>
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            </Button>
          );
        })}
      </nav>

      <div className="border-t p-4">
        <p className="text-xs text-muted-foreground">v0.1.0</p>
      </div>
    </aside>
  );
}
