"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { fetchJson } from "@/lib/http";
import { isBoolean, usePersistedState } from "@/hooks/use-persisted-state";
import { useSidebarNav } from "@/components/providers/sidebar-nav-provider";
import { useCommandPalette } from "@/components/providers/command-palette-provider";
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
import { Mail, Shield, Search, Loader2 } from "lucide-react";

const adminNavItem = { href: "/admin/models", label: "Admin", icon: Shield };

export function DashboardNav({ workspaceName }: { workspaceName: string }) {
  const pathname = usePathname();
  const { visibleItems } = useSidebarNav();
  const { show: showPalette } = useCommandPalette();
  const rowRef = useRowFlip(visibleItems.map((item) => item.id));
  const activeAccountId = useSearchParams().get("accountId");
  const isAccountActive = (accountId: string) =>
    pathname === "/dashboard/mail" && activeAccountId === accountId;
  const [mailExpanded, setMailExpanded] = usePersistedState("nav:mailExpanded", false, {
    validate: isBoolean,
  });
  // One nav item's sections are open at a time, and only for the area you are in:
  // a remembered value left it hanging open on unrelated pages.
  const [expandedNavId, setExpandedNavId] = useState<string | null>(null);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);
  const isAdmin = useIsAdmin();

  // The user's mail accounts, under the Mail row.
  useEffect(() => {
    fetchJson<{ accounts: EmailAccount[] }>("/api/email/accounts")
      .then((data) => {
        setEmailAccounts(data.accounts ?? []);
        setEmailLoading(false);
      })
      .catch((err) => {
        console.error("Failed to read the mail accounts:", err);
        setEmailLoading(false);
      });
  }, []);

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
      <SidebarBrand name={workspaceName} />

      {/* Search. the ⌘K box, rendered once by the shell's provider */}
      <div className="px-1 pb-2">
        <Button
          variant="ghost"
          className="text-muted-foreground h-8 w-full justify-start gap-2 rounded-lg px-2"
          onClick={showPalette}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-left text-xs">Search...</span>
          <kbd className="bg-muted/50 text-muted-foreground/50 rounded border px-1.5 py-0.5 font-mono text-[10px]">
            ⌘K
          </kbd>
        </Button>
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

      <SidebarFooter workspaceName={workspaceName} />
    </SidebarFrame>
  );
}
