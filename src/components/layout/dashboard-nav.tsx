"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/http";
import { useClickOutside } from "@/hooks/use-click-outside";
import type { EmailAccount } from "@/types/shared";
import { Separator } from "@/components/ui/separator";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare,
  Mail,
  ListTodo,
  Calendar,
  Settings,
  Shield,
  ChevronRight,
  ChevronDown,
  Moon,
  Sun,
  Search,
  X,
  Loader2,
} from "lucide-react";
import { useTheme } from "next-themes";

const navItems = [
  { href: "/dashboard/chat", label: "Chat", icon: MessageSquare },
  { href: "/dashboard/calendar", label: "Calendar", icon: Calendar },
  { href: "/dashboard/jobs", label: "Jobs", icon: ListTodo },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

const adminNavItem = { href: "/admin/models", label: "Admin", icon: Shield };

interface SearchResult {
  type: "chat" | "email";
  id: string;
  title: string;
  snippet: string;
  date: string;
}

export function DashboardNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [mailExpanded, setMailExpanded] = useState(false);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [searchPosition, setSearchPosition] = useState<{ top: number; left: number } | null>(null);

  // Update portal position on open, scroll, and resize
  useEffect(() => {
    if (!searchOpen || !searchRef.current) return;

    const updatePosition = () => {
      const rect = searchRef.current!.getBoundingClientRect();
      setSearchPosition({ top: rect.bottom, left: rect.left });
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [searchOpen]);

  // Load email accounts
  useEffect(() => {
    fetchJson<{ accounts: EmailAccount[] }>("/api/email/accounts")
      .then((data) => {
        setEmailAccounts(data.accounts ?? []);
        setEmailLoading(false);
      })
      .catch(() => setEmailLoading(false));
  }, []);

  // Check if user is admin
  useEffect(() => {
    fetchJson<{ user?: { role?: string | null } }>("/api/auth/get-session")
      .then((data) => {
        setIsAdmin(data.user?.role === "admin");
      })
      .catch((err) => {
        console.error("Failed to check admin status:", err);
      });
  }, []);

  // Close search on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
      // Cmd/Ctrl + K to open search
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchOpen]);

  // Listen for focus-search event from keyboard shortcuts
  useEffect(() => {
    const handleFocusSearch = () => {
      setSearchOpen(true);
    };
    window.addEventListener("focus-search", handleFocusSearch);
    return () => window.removeEventListener("focus-search", handleFocusSearch);
  }, []);

  // Close search on outside click
  useClickOutside(searchRef, () => setSearchOpen(false));

  // Search handler
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const data = await fetchJson<{ results: SearchResult[] }>(
          `/api/search?q=${encodeURIComponent(searchQuery)}&limit=10`,
        );
        setSearchResults(data.results);
      } catch {
        // Ignore
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleResultClick = (result: SearchResult) => {
    setSearchOpen(false);
    setSearchQuery("");
    if (result.type === "chat") {
      router.push(`/dashboard/chat/${result.id}`);
    } else if (result.type === "email") {
      router.push("/dashboard/mail");
    }
  };

  const isMailActive = pathname === "/dashboard/mail" || pathname.startsWith("/dashboard/mail/");

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
            <NotificationBell />
          </div>

          <Separator className="my-2" />

          {/* Search */}
          <div className="px-1 pb-2" ref={searchRef}>
            <div className="relative">
              <Button
                variant="ghost"
                className="text-muted-foreground h-8 w-full justify-start gap-2 rounded-lg px-2"
                onClick={() => setSearchOpen((prev) => !prev)}
              >
                <Search className="h-3.5 w-3.5" />
                <span className="flex-1 text-left text-xs">Search...</span>
                <kbd className="text-muted-foreground/50 bg-muted/50 rounded border px-1.5 py-0.5 text-[10px]">
                  ⌘K
                </kbd>
              </Button>

              {/* Search dropdown — rendered via portal to escape GlassPanel's overflow-hidden */}
              {searchOpen &&
                searchPosition &&
                createPortal(
                  <div
                    className="liquid-glass fixed z-50 mt-1 w-72 rounded-xl border-0 shadow-2xl"
                    style={{
                      top: searchPosition.top,
                      left: searchPosition.left,
                    }}
                  >
                    <div className="flex items-center gap-2 border-b px-3 py-2">
                      <Search className="text-muted-foreground h-4 w-4" />
                      <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search chats, emails..."
                        className="h-8 border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
                        autoFocus
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => {
                          setSearchOpen(false);
                          setSearchQuery("");
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>

                    <div className="max-h-64 overflow-y-auto p-1">
                      {searchLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                        </div>
                      ) : !searchQuery ? null : searchResults.length === 0 ? (
                        <div className="text-muted-foreground py-4 text-center text-sm">
                          No results found
                        </div>
                      ) : (
                        searchResults.map((result) => (
                          <button
                            key={result.id}
                            onClick={() => handleResultClick(result)}
                            className="hover:bg-muted/50 flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors"
                          >
                            <Badge
                              variant="secondary"
                              className={cn(
                                "shrink-0 rounded-full px-1.5 py-0 text-[10px]",
                                result.type === "chat"
                                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                                  : "bg-green-500/10 text-green-600 dark:text-green-400",
                              )}
                            >
                              {result.type}
                            </Badge>
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium">{result.title}</div>
                              <div className="text-muted-foreground truncate text-xs">
                                {result.snippet}
                              </div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  </div>,
                  document.body,
                )}
            </div>
          </div>

          {/* Nav Items */}
          <div className="space-y-0.5">
            {/* Chat */}
            {navItems
              .filter((item) => item.href === "/dashboard/chat")
              .map((item) => {
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

            {/* Mail with expandable accounts */}
            <div>
              <button
                onClick={() => {
                  if (emailAccounts.length > 0) {
                    setMailExpanded((prev) => !prev);
                  } else {
                    router.push("/dashboard/mail");
                  }
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                  isMailActive
                    ? "bg-white/20 font-medium dark:bg-white/5"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/10",
                )}
              >
                <Mail className="h-4 w-4" />
                Mail
                {emailAccounts.length > 0 && (
                  <span className="ml-auto">
                    {mailExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </span>
                )}
              </button>

              {/* Expanded email accounts */}
              {mailExpanded && emailAccounts.length > 0 && (
                <div className="mt-0.5 space-y-0.5 pl-4">
                  {/* All Mail */}
                  <Link
                    href="/dashboard/mail"
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors",
                      pathname === "/dashboard/mail"
                        ? "bg-white/20 font-medium dark:bg-white/5"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/10",
                    )}
                  >
                    All Mail
                  </Link>

                  {emailLoading ? (
                    <div className="px-3 py-1.5">
                      <Loader2 className="h-3 w-3 animate-spin" />
                    </div>
                  ) : (
                    emailAccounts.map((acc) => {
                      const shortName = acc.email.split("@")[0];
                      const domain = acc.email.split("@")[1] ?? "";

                      return (
                        <Link
                          key={acc.id}
                          href={`/dashboard/mail?accountId=${acc.id}`}
                          className={cn(
                            "flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors",
                            pathname === "/dashboard/mail" &&
                              new URLSearchParams(window.location.search).get("accountId") ===
                                acc.id
                              ? "bg-white/20 font-medium dark:bg-white/5"
                              : "text-muted-foreground hover:text-foreground hover:bg-white/10",
                          )}
                        >
                          <div className="bg-muted/50 flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold">
                            {acc.email[0]?.toUpperCase() ?? "?"}
                          </div>
                          <span className="truncate">{shortName}</span>
                          <span className="text-muted-foreground/50">@{domain}</span>
                          {!acc.enabled && (
                            <span className="ml-auto text-[9px] opacity-50">off</span>
                          )}
                        </Link>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* Remaining nav items (Jobs, Settings) */}
            {navItems
              .filter((item) => item.href !== "/dashboard/chat")
              .map((item) => {
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

            {/* Admin link — shown only to admin users */}
            {isAdmin && (
              <Link
                href={adminNavItem.href}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                  pathname.startsWith("/admin")
                    ? "bg-white/20 font-medium dark:bg-white/5"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/10",
                )}
              >
                <adminNavItem.icon className="h-4 w-4" />
                {adminNavItem.label}
              </Link>
            )}
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
