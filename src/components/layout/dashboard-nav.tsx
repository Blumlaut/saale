"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/http";
import { useClickOutside } from "@/hooks/use-click-outside";
import { isBoolean, usePersistedState } from "@/hooks/use-persisted-state";
import { useSidebarNav } from "@/components/providers/sidebar-nav-provider";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { SIDEBAR_NAV_ICONS } from "@/components/layout/sidebar-nav-icons";
import { isSidebarNavActive, type SidebarNavItem } from "@/lib/navigation/sidebar-nav";
import {
  SETTINGS_GROUPS,
  SETTINGS_GROUP_LABELS,
  SETTINGS_SECTIONS,
  settingsSectionsInGroup,
} from "@/lib/navigation/settings-nav";
import type { EmailAccount } from "@/types/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SidebarBrand,
  SidebarFooter,
  SidebarFrame,
  SidebarItem,
  SidebarSectionList,
  SidebarSections,
  SidebarSectionToggle,
  sidebarSectionItemClass,
  useRowFlip,
} from "@/components/layout/sidebar-chrome";
import { Badge } from "@/components/ui/badge";
import { Mail, Shield, Search, X, Loader2 } from "lucide-react";

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
  const { visibleItems } = useSidebarNav();
  const rowRef = useRowFlip(visibleItems.map((item) => item.id));
  const activeAccountId = useSearchParams().get("accountId");
  const isAccountActive = (accountId: string) =>
    pathname === "/dashboard/mail" && activeAccountId === accountId;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [mailExpanded, setMailExpanded] = usePersistedState("nav:mailExpanded", false, {
    validate: isBoolean,
  });
  // One nav item's sections are open at a time, and only for the area you are in:
  // a remembered value left it hanging open on unrelated pages.
  const [expandedNavId, setExpandedNavId] = useState<string | null>(null);
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

  /* Mail carries the user's accounts: the row goes to the inbox, the toggle opens them. */
  const renderMailItem = (item: SidebarNavItem) => (
    <div key={item.id} ref={rowRef(item.id)}>
      <SidebarItem
        href={item.href}
        label={item.label}
        icon={Mail}
        active={isSidebarNavActive(item.href, pathname) && !activeAccountId}
        trailing={
          emailAccounts.length > 0 ? (
            <SidebarSectionToggle
              label={item.label}
              expanded={mailExpanded}
              onToggle={() => setMailExpanded((prev) => !prev)}
            />
          ) : undefined
        }
      />

      <SidebarSections open={mailExpanded && emailAccounts.length > 0}>
        {emailLoading ? (
          <div className="px-2 py-1">
            <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />
          </div>
        ) : (
          emailAccounts.map((account) => {
            const [local, domain] = account.email.split("@");

            return (
              <Link
                key={account.id}
                href={`/dashboard/mail?accountId=${account.id}`}
                className={sidebarSectionItemClass(isAccountActive(account.id))}
              >
                <div className="bg-muted/50 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold">
                  {account.email[0]?.toUpperCase() ?? "?"}
                </div>
                <span className="truncate">{local}</span>
                <span className="text-muted-foreground/50 truncate">@{domain}</span>
                {!account.enabled && <span className="ml-auto text-[9px] opacity-50">off</span>}
              </Link>
            );
          })
        )}
      </SidebarSections>
    </div>
  );

  /*
   * Settings opens its sections instead of a second navigation: the sidebar is
   * the only nav, so a settings page has nowhere else to pick a section from.
   */
  // Arriving in an area opens its sections and leaving closes them again, so the
  // sidebar always matches the page you are on.
  const areaId =
    visibleItems.find(
      (item) =>
        (item.id === "settings" || (item.sections?.length ?? 0) > 0) &&
        isSidebarNavActive(item.href, pathname),
    )?.id ?? null;

  useEffect(() => {
    setExpandedNavId(areaId);
  }, [areaId]);

  /** The sections an item expands into, grouped the way the picker shows them. */
  const sectionGroupsFor = (item: SidebarNavItem) => {
    if (item.id === "settings") {
      return SETTINGS_GROUPS.map((group) => ({
        label: SETTINGS_GROUP_LABELS[group] ?? null,
        items: settingsSectionsInGroup(group).map((section) => ({
          id: section.id,
          href: section.href,
          label: section.label,
        })),
      })).filter((group) => group.items.length > 0);
    }

    return [
      {
        label: null,
        items: (item.sections ?? []).map((section) => ({
          id: section.id,
          href: section.href,
          label: section.label,
        })),
      },
    ];
  };

  const activeSectionId = (item: SidebarNavItem): string | undefined => {
    const sections = item.id === "settings" ? SETTINGS_SECTIONS : (item.sections ?? []);
    return sections.find(
      (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
    )?.id;
  };

  /** A nav item that opens its pages in the sidebar instead of navigating away. */
  const renderSectionedItem = (item: SidebarNavItem) => {
    const expanded = expandedNavId === item.id;

    return (
      <div key={item.id}>
        <SidebarItem
          rowRef={rowRef(item.id)}
          href={item.href}
          label={item.label}
          icon={SIDEBAR_NAV_ICONS[item.id]}
          active={isSidebarNavActive(item.href, pathname)}
          trailing={
            <SidebarSectionToggle
              label={item.label}
              expanded={expanded}
              onToggle={() => setExpandedNavId(expanded ? null : item.id)}
            />
          }
        />
        <SidebarSections open={expanded}>
          <SidebarSectionList groups={sectionGroupsFor(item)} activeId={activeSectionId(item)} />
        </SidebarSections>
      </div>
    );
  };

  return (
    <SidebarFrame>
      <SidebarBrand />

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
                          className="shrink-0 rounded px-1.5 py-0 text-[10px] tracking-wide uppercase"
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
          if (item.id === "mail") return renderMailItem(item);
          if (item.id === "settings" || (item.sections?.length ?? 0) > 0) {
            return renderSectionedItem(item);
          }

          return (
            <SidebarItem
              key={item.id}
              rowRef={rowRef(item.id)}
              href={item.href}
              label={item.label}
              icon={SIDEBAR_NAV_ICONS[item.id]}
              active={isSidebarNavActive(item.href, pathname)}
            />
          );
        })}

        {/* Admin link. shown only to admin users */}
        {isAdmin && (
          <SidebarItem
            href={adminNavItem.href}
            label={adminNavItem.label}
            icon={adminNavItem.icon}
            active={pathname.startsWith("/admin")}
          />
        )}
      </div>

      <SidebarFooter />
    </SidebarFrame>
  );
}
