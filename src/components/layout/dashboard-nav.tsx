"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/http";
import { useClickOutside } from "@/hooks/use-click-outside";
import { isBoolean, usePersistedState } from "@/hooks/use-persisted-state";
import { useResizableWidth } from "@/hooks/use-resizable-width";
import { useSidebarNav } from "@/components/providers/sidebar-nav-provider";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { SIDEBAR_NAV_ICONS } from "@/components/layout/sidebar-nav-icons";
import { isSidebarNavActive, type SidebarNavItem } from "@/lib/navigation/sidebar-nav";
import {
  isSettingsPath,
  SETTINGS_GROUPS,
  settingsSectionForPath,
  settingsSectionsInGroup,
} from "@/lib/navigation/settings-nav";
import type { EmailAccount } from "@/types/shared";
import { Separator } from "@/components/ui/separator";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Mail,
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

const adminNavItem = { href: "/admin/models", label: "Admin", icon: Shield };

/* Console nav item. active state gets an accent fill + orange edge bar */
function navItemClass(active: boolean, extra = "") {
  return cn(
    "relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors duration-150",
    active
      ? "bg-accent font-medium text-foreground before:absolute before:left-0 before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
    extra,
  );
}

/** A settings section, nested under the Settings item. Looks like a nav item. */
function sectionItemClass(active: boolean) {
  return cn(
    "flex items-center rounded-lg px-2 py-0.5 text-sm transition-colors duration-150",
    active
      ? "bg-accent text-foreground font-medium"
      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );
}

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
  const { visibleItems } = useSidebarNav();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [mailExpanded, setMailExpanded] = usePersistedState("nav:mailExpanded", false, {
    validate: isBoolean,
  });
  const [settingsExpanded, setSettingsExpanded] = usePersistedState("nav:settingsExpanded", false, {
    validate: isBoolean,
  });
  const inSettings = isSettingsPath(pathname);

  // Arriving in settings opens the section list, wherever it was left last time.
  useEffect(() => {
    if (inSettings) setSettingsExpanded(true);
  }, [inSettings, setSettingsExpanded]);
  const navWidth = useResizableWidth({
    storageKey: "saale:ui:nav:width",
    label: "Resize navigation",
    defaultWidth: 192,
    minWidth: 160,
    maxWidth: 320,
    handle: "right",
  });
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);
  const isAdmin = useIsAdmin();
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

  /* Mail's nav item expands into the user's accounts instead of navigating directly. */
  const renderMailItem = (item: SidebarNavItem) => (
    <div key={item.id}>
      <button
        onClick={() => {
          if (emailAccounts.length > 0) {
            setMailExpanded((prev) => !prev);
          } else {
            router.push(item.href);
          }
        }}
        className={navItemClass(isSidebarNavActive(item.href, pathname), "w-full")}
      >
        <Mail className="h-4 w-4" />
        {item.label}
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
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
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
                      new URLSearchParams(window.location.search).get("accountId") === acc.id
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  <div className="bg-muted/50 flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold">
                    {acc.email[0]?.toUpperCase() ?? "?"}
                  </div>
                  <span className="truncate">{shortName}</span>
                  <span className="text-muted-foreground/50">@{domain}</span>
                  {!acc.enabled && <span className="ml-auto text-[9px] opacity-50">off</span>}
                </Link>
              );
            })
          )}
        </div>
      )}
    </div>
  );

  /*
   * Settings opens its sections instead of a second navigation: the sidebar is
   * the only nav, so a settings page has nowhere else to pick a section from.
   */
  const renderSettingsItem = (item: SidebarNavItem) => {
    const Icon = SIDEBAR_NAV_ICONS[item.id];
    const activeSection = settingsSectionForPath(pathname);

    return (
      <div key={item.id}>
        <div className="flex items-center gap-1">
          <Link
            href={item.href}
            className={navItemClass(isSidebarNavActive(item.href, pathname), "min-w-0 flex-1")}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-7 shrink-0 rounded-md"
            aria-expanded={settingsExpanded}
            aria-label={settingsExpanded ? "Hide settings sections" : "Show settings sections"}
            onClick={() => setSettingsExpanded((prev) => !prev)}
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-150",
                !settingsExpanded && "-rotate-90",
              )}
            />
          </Button>
        </div>

        {settingsExpanded && (
          <div className="border-border/60 mt-1 ml-3.5 border-l pl-1.5">
            {SETTINGS_GROUPS.map((group, index) => {
              const sections = settingsSectionsInGroup(group);
              if (sections.length === 0) return null;

              return (
                <div
                  key={group}
                  className={index > 0 ? "border-border/60 border-t pt-1" : undefined}
                >
                  {sections.map((section) => (
                    <Link
                      key={section.id}
                      href={section.href}
                      aria-current={activeSection?.id === section.id ? "page" : undefined}
                      className={sectionItemClass(activeSection?.id === section.id)}
                    >
                      <span className="truncate">{section.label}</span>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <nav
      className="sidebar-nav no-scrollbar relative sticky top-6 max-h-[calc(100dvh-3rem)] shrink-0 overflow-y-auto"
      style={{ width: navWidth.width }}
    >
      <GlassPanel className="shadow-md">
        <div
          {...navWidth.handleProps}
          className="hover:bg-border absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize"
        />
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
                <kbd className="bg-muted/50 text-muted-foreground/50 rounded border px-1.5 py-0.5 font-mono text-[10px]">
                  ⌘K
                </kbd>
              </Button>

              {/* Search dropdown. rendered via portal to escape GlassPanel's overflow-hidden */}
              {searchOpen &&
                searchPosition &&
                createPortal(
                  <div
                    className="liquid-glass fixed z-50 mt-1 w-72 rounded-xl shadow-2xl"
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
                              className="shrink-0 rounded px-1.5 py-0 font-mono text-[10px] tracking-wide uppercase"
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

          {/* Nav Items. order and visibility come from the user's layout */}
          <div className="space-y-0.5">
            {visibleItems.map((item) => {
              const Icon = SIDEBAR_NAV_ICONS[item.id];
              if (item.id === "mail") return renderMailItem(item);
              if (item.id === "settings") return renderSettingsItem(item);

              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={navItemClass(isSidebarNavActive(item.href, pathname))}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}

            {/* Admin link. shown only to admin users */}
            {isAdmin && (
              <Link
                href={adminNavItem.href}
                className={navItemClass(pathname.startsWith("/admin"))}
              >
                <adminNavItem.icon className="h-4 w-4" />
                {adminNavItem.label}
              </Link>
            )}
          </div>
        </GlassPanelContent>
      </GlassPanel>

      {/* Console footer. version + theme toggle */}
      <div className="border-border/60 mt-4 border-t px-3 pt-3">
        <div className="flex items-center justify-between">
          <p className="console-label">
            Saale{" "}
            <span className="text-muted-foreground/70 font-mono tracking-normal normal-case">
              v0.1.0
            </span>
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-md"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label="Toggle theme"
          >
            <Sun className="h-3.5 w-3.5 dark:hidden" />
            <Moon className="hidden h-3.5 w-3.5 dark:block" />
          </Button>
        </div>
        <div className="bg-primary mt-2 h-0.5 w-8 rounded-full" />
      </div>
    </nav>
  );
}
