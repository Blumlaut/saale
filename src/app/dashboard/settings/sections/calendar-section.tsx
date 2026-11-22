"use client";

import { Fragment, useState, useEffect } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import { OVERLAY_EXIT_MS } from "@/lib/utils";
import {
  Calendar,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  MoreVertical,
  HardDrive,
  Globe,
  Link as LinkIcon,
} from "lucide-react";
import { CalendarsExpandable } from "../components/calendars-expandable";
import { SettingsError } from "../components/settings-error";
import { SyncResult } from "../components/sync-result";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CalendarAccountDialog } from "@/components/calendar/calendar-account-dialog";
import { SubscriptionDialog } from "@/components/calendar/subscription-dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import type { CalendarAccountSummary } from "@/types/shared";

interface Subscription {
  id: string;
  name: string;
  url: string;
  calendarId: string;
  calendarName: string;
  calendarColor: string | null;
  enabled: boolean;
  lastSyncedAt: string | null;
}

export function CalendarSection() {
  const [accounts, setAccounts] = useState<CalendarAccountSummary[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [subscriptionDialogOpen, setSubscriptionDialogOpen] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
    type: "account" | "subscription";
  } | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [syncResult, setSyncResult] = useState<{
    id: string;
    created: number;
    updated: number;
    deleted: number;
    parsed: number | null;
  } | null>(null);

  const loadData = async () => {
    try {
      let accountsRes = await fetchJson<{ accounts: CalendarAccountSummary[] }>(
        "/api/calendar/accounts",
      );
      const accountsList = accountsRes.accounts ?? [];

      // Ensure local account exists
      if (!accountsList.some((a) => a.accountType === "local")) {
        await fetchJson("/api/calendar/ensure-local-account").catch((err) => {
          console.error("Failed to ensure local calendar account:", err);
        });
        accountsRes = await fetchJson<{ accounts: CalendarAccountSummary[] }>(
          "/api/calendar/accounts",
        );
        accountsList.length = 0;
        accountsList.push(...(accountsRes.accounts ?? []));
      }

      const subsRes = await fetchJson<{ subscriptions: Subscription[] }>(
        "/api/calendar/subscriptions",
      );
      setAccounts(accountsList);
      setSubscriptions(subsRes.subscriptions ?? []);
      setError(null);
    } catch (err) {
      console.error("Failed to load the calendar accounts:", err);
      setError("Could not load your calendars.");
    }
  };

  useEffect(() => {
    loadData().then(() => setLoading(false));
  }, []);

  const toggleExpanded = (accountId: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const executeAction = async (
    id: string,
    action: "sync" | "sync-sub",
    type: "account" | "subscription",
  ) => {
    setActionLoading(action + ":" + id);
    try {
      const url =
        type === "account"
          ? `/api/calendar/accounts/${id}/sync`
          : `/api/calendar/subscriptions/${id}`;

      if (action === "sync-sub") {
        const res = await postJson<{
          sync: {
            eventsCreated: number;
            eventsUpdated: number;
            eventsDeleted: number;
            parsedEvents: number | null;
            error: string | null;
          };
        }>(url, {});
        if (res.sync?.error) {
          setAlertError(res.sync.error);
        } else {
          setSyncResult({
            id,
            created: res.sync.eventsCreated,
            updated: res.sync.eventsUpdated,
            deleted: res.sync.eventsDeleted,
            parsed: res.sync.parsedEvents ?? null,
          });
        }
      } else {
        const res = await postJson<{
          sync: {
            calendarsSynced: number;
            eventsCreated: number;
            eventsUpdated: number;
            eventsDeleted: number;
            errors: string[];
          };
        }>(url, {});
        if (res.sync?.errors?.length) {
          setAlertError(res.sync.errors.join("; "));
        } else {
          setSyncResult({
            id,
            created: res.sync.eventsCreated,
            updated: res.sync.eventsUpdated,
            deleted: res.sync.eventsDeleted,
            parsed: null,
          });
        }
      }
      await loadData();
    } catch (err) {
      console.error("Failed to sync the calendar:", err);
      setAlertError((err as Error).message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const base =
      deleteTarget.type === "account"
        ? `/api/calendar/accounts/${deleteTarget.id}`
        : `/api/calendar/subscriptions/${deleteTarget.id}`;
    try {
      await deleteJson(base);
      await loadData();
    } catch (err) {
      console.error("Failed to delete the calendar entry:", err);
      throw err;
    }
  };

  const handleToggleAccountEnabled = async (accountId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/calendar/accounts/${accountId}`, { enabled });
      await loadData();
    } catch (err) {
      console.error("Failed to change whether the calendar account is on:", err);
      setError("Could not change that calendar account.");
    }
  };

  const handleToggleSubscriptionEnabled = async (subscriptionId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/calendar/subscriptions/${subscriptionId}`, { enabled });
      await loadData();
    } catch (err) {
      console.error("Failed to change whether the subscription is on:", err);
      setError("Could not change that subscription.");
    }
  };

  const handleSyncAll = async () => {
    setActionLoading("sync-all");
    try {
      const promises = accounts
        .filter((a) => a.accountType === "caldav")
        .map((acc) => postJson(`/api/calendar/accounts/${acc.id}/sync`, {}));
      const subPromises = subscriptions
        .filter((s) => s.enabled)
        .map((sub) => postJson(`/api/calendar/subscriptions/${sub.id}`, {}));
      await Promise.all([...promises, ...subPromises]);
      await loadData();
    } catch (err) {
      console.error("Failed to sync the calendars:", err);
      setError("Could not sync every calendar. Try one at a time.");
    } finally {
      setActionLoading(null);
    }
  };

  const totalEvents = accounts.reduce(
    (sum, acc) => sum + acc.calendars.reduce((c, cal) => c + (cal.eventCount ?? 0), 0),
    0,
  );

  const localAccount = accounts.find((a) => a.accountType === "local");
  const caldavAccounts = accounts.filter((a) => a.accountType === "caldav");

  return (
    <>
      {/* Accounts */}
      <GlassPanel>
        <GlassPanelContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <Calendar className="h-5 w-5" />
                Calendars
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Manage your calendar accounts
                {accounts.length > 0 && ` · ${totalEvents} total events`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {accounts.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSyncAll}
                  disabled={actionLoading === "sync-all"}
                >
                  {actionLoading === "sync-all" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Sync All
                </Button>
              )}
              <Button size="sm" onClick={() => setAccountDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add CalDAV
              </Button>
            </div>
          </div>

          <SettingsError>{error}</SettingsError>

          {loading ? (
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          ) : accounts.length === 0 ? (
            <div className="border-border/50 rounded-2xl border border-dashed p-8 text-center">
              <Calendar className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                Setting up your local calendar...
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Local account */}
              {localAccount && (
                <div className="bg-muted overflow-hidden rounded-2xl border-0">
                  <div className="flex items-center justify-between p-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <HardDrive className="text-muted-foreground h-4 w-4" />
                        <p className="text-sm font-medium">{localAccount.name}</p>
                        <span className="text-muted-foreground bg-muted/50 rounded-full px-2 py-0.5 text-[10px]">
                          local
                        </span>
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {localAccount.calendars.length} calendar
                        {localAccount.calendars.length !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>

                  {localAccount.calendars.length > 0 && (
                    <CalendarsExpandable
                      calendars={localAccount.calendars}
                      isExpanded={expandedAccounts.has(localAccount.id)}
                      onToggle={() => toggleExpanded(localAccount.id)}
                    />
                  )}
                </div>
              )}

              {/* CalDAV accounts */}
              {caldavAccounts.map((account) => {
                const isBusy =
                  actionLoading === "sync:" + account.id || actionLoading === "sync-all";
                const isExpanded = expandedAccounts.has(account.id);

                return (
                  <div key={account.id} className="bg-muted overflow-hidden rounded-2xl border-0">
                    <div className="flex items-center justify-between p-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <Globe className="text-muted-foreground h-4 w-4" />
                          <p className="text-sm font-medium">{account.name}</p>
                          {!account.enabled && (
                            <span className="text-muted-foreground bg-muted/50 rounded-full px-2 py-0.5 text-[10px]">
                              Disabled
                            </span>
                          )}
                        </div>
                        <p className="text-muted-foreground text-xs">
                          {account.username} · {account.calendars.length} calendar
                          {account.calendars.length !== 1 ? "s" : ""}
                          {account.lastSyncedAt
                            ? ` · Last synced ${new Date(account.lastSyncedAt).toLocaleString()}`
                            : " · Never synced"}
                        </p>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">Enable</span>
                          <Switch
                            checked={account.enabled}
                            onCheckedChange={(v) => handleToggleAccountEnabled(account.id, v)}
                          />
                        </div>

                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={isBusy}
                                aria-label={`Actions for ${account.name}`}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => void executeAction(account.id, "sync", "account")}
                              disabled={isBusy}
                            >
                              {actionLoading === "sync:" + account.id ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-2 h-4 w-4" />
                              )}
                              Sync Now
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                setDeleteTarget({
                                  id: account.id,
                                  name: account.name,
                                  type: "account",
                                })
                              }
                              disabled={isBusy}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete Account
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {account.calendars.length > 0 && (
                      <CalendarsExpandable
                        calendars={account.calendars}
                        isExpanded={isExpanded}
                        onToggle={() => toggleExpanded(account.id)}
                      />
                    )}

                    {/* Sync result */}
                    <SyncResult
                      itemId={account.id}
                      syncResult={syncResult}
                      className="border-border/50 border-t px-4 py-2"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      {/* Subscriptions */}
      <GlassPanel>
        <GlassPanelContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <LinkIcon className="h-5 w-5" />
                ICS Subscriptions
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Sync remote ICS feeds into your local calendar
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setEditingSubscription(null);
                setSubscriptionDialogOpen(true);
              }}
              disabled={!localAccount}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Subscription
            </Button>
          </div>

          {subscriptions.length === 0 ? (
            <div className="border-border/50 rounded-2xl border border-dashed p-8 text-center">
              <LinkIcon className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                No subscriptions yet. Add a remote ICS URL to sync events.
              </p>
              <p className="text-muted-foreground/60 mt-1 text-xs">
                Public calendars, holiday feeds, team schedules, etc.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {subscriptions.map((sub) => {
                const isBusy = actionLoading === "sync-sub:" + sub.id;

                return (
                  <Fragment key={sub.id}>
                    <div className="bg-muted flex items-center justify-between rounded-2xl border-0 p-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{sub.name}</p>
                          {!sub.enabled && (
                            <span className="text-muted-foreground bg-muted/50 rounded-full px-2 py-0.5 text-[10px]">
                              Disabled
                            </span>
                          )}
                        </div>
                        <p className="text-muted-foreground text-xs">
                          {sub.calendarName}
                          {sub.lastSyncedAt
                            ? ` · Last synced ${new Date(sub.lastSyncedAt).toLocaleString()}`
                            : " · Never synced"}
                        </p>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">Enable</span>
                          <Switch
                            checked={sub.enabled}
                            onCheckedChange={(v) => handleToggleSubscriptionEnabled(sub.id, v)}
                          />
                        </div>

                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={isBusy}
                                aria-label={`Actions for ${sub.name}`}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => {
                                setEditingSubscription(sub);
                                setSubscriptionDialogOpen(true);
                              }}
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => void executeAction(sub.id, "sync-sub", "subscription")}
                              disabled={isBusy}
                            >
                              {isBusy ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-2 h-4 w-4" />
                              )}
                              Sync Now
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                setDeleteTarget({
                                  id: sub.id,
                                  name: sub.name,
                                  type: "subscription",
                                })
                              }
                              disabled={isBusy}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    {/* Sync result */}
                    <SyncResult
                      itemId={sub.id}
                      syncResult={syncResult}
                      showParsed
                      className="-mt-1 px-4"
                    />
                  </Fragment>
                );
              })}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <CalendarAccountDialog
        open={accountDialogOpen}
        onOpenChange={setAccountDialogOpen}
        onSuccess={loadData}
      />

      <SubscriptionDialog
        open={subscriptionDialogOpen}
        onOpenChange={(open) => {
          if (!open) setEditingSubscription(null);
          setSubscriptionDialogOpen(open);
        }}
        accounts={accounts}
        subscription={editingSubscription}
        onSuccess={loadData}
        onRequestDelete={(id) =>
          setTimeout(() => {
            const subscription = subscriptions.find((entry) => entry.id === id);
            setDeleteTarget({
              id,
              name: subscription?.name ?? "this subscription",
              type: "subscription",
            });
          }, OVERLAY_EXIT_MS)
        }
      />

      {/* A sync that came back with a reason of its own. */}
      <AlertDialog open={alertError !== null} onOpenChange={(open) => !open && setAlertError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Error</AlertDialogTitle>
            <AlertDialogDescription>{alertError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setAlertError(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={
          deleteTarget?.type === "account"
            ? `Delete the ${deleteTarget.name} account?`
            : `Remove ${deleteTarget?.name ?? "this subscription"}?`
        }
        description="Its synced events go with it. This cannot be undone."
        confirmLabel={deleteTarget?.type === "account" ? "Delete" : "Remove"}
        busyLabel={deleteTarget?.type === "account" ? "Deleting…" : "Removing…"}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}
