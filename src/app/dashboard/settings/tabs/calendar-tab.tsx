"use client";

import { useState, useEffect } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import {
  Calendar,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  MoreVertical,
  ChevronRight,
  ChevronDown,
  HardDrive,
  Globe,
  Link as LinkIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CalendarAccountDialog } from "@/components/calendar/calendar-account-dialog";
import { SubscriptionDialog } from "@/components/calendar/subscription-dialog";

interface CalendarAccount {
  id: string;
  name: string;
  accountType: string;
  serverUrl: string | null;
  username: string | null;
  enabled: boolean;
  lastSyncedAt: string | null;
  calendars: Array<{
    id: string;
    remoteId: string;
    name: string;
    color: string | null;
    enabled: boolean;
    lastSyncedAt: string | null;
    eventCount: number;
  }>;
}

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

export function CalendarTab() {
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [subscriptionDialogOpen, setSubscriptionDialogOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    id: string;
    action: "sync" | "delete" | "sync-sub" | "delete-sub";
    type: "account" | "subscription";
  } | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);
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
      let accountsRes = await fetchJson<{ accounts: CalendarAccount[] }>("/api/calendar/accounts");
      const accountsList = accountsRes.accounts ?? [];

      // Ensure local account exists
      if (!accountsList.some((a) => a.accountType === "local")) {
        await fetchJson("/api/calendar/ensure-local-account").catch(() => {});
        accountsRes = await fetchJson<{ accounts: CalendarAccount[] }>("/api/calendar/accounts");
        accountsList.length = 0;
        accountsList.push(...(accountsRes.accounts ?? []));
      }

      const subsRes = await fetchJson<{ subscriptions: Subscription[] }>(
        "/api/calendar/subscriptions",
      );
      setAccounts(accountsList);
      setSubscriptions(subsRes.subscriptions ?? []);
    } catch {
      // Ignore
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
    action: "sync" | "delete" | "sync-sub" | "delete-sub",
    type: "account" | "subscription",
  ) => {
    setActionLoading(action + ":" + id);
    try {
      let url: string;
      let method: "POST" | "DELETE";

      if (type === "account") {
        url =
          action === "delete"
            ? `/api/calendar/accounts/${id}`
            : `/api/calendar/accounts/${id}/sync`;
        method = action === "delete" ? "DELETE" : "POST";
      } else {
        url = `/api/calendar/subscriptions/${id}`;
        method = action === "delete-sub" ? "DELETE" : "POST";
      }

      if (method === "DELETE") {
        await deleteJson(url);
      } else if (action === "sync-sub") {
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
          setPendingAction({ id, action, type });
          setAlertOpen(true);
        } else {
          setSyncResult({
            id,
            created: res.sync.eventsCreated,
            updated: res.sync.eventsUpdated,
            deleted: res.sync.eventsDeleted,
            parsed: res.sync.parsedEvents ?? null,
          });
        }
      } else if (action === "sync") {
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
          setPendingAction({ id, action, type });
          setAlertOpen(true);
        } else {
          setSyncResult({
            id,
            created: res.sync.eventsCreated,
            updated: res.sync.eventsUpdated,
            deleted: res.sync.eventsDeleted,
            parsed: null,
          });
        }
      } else {
        await postJson(url, {});
      }
      await loadData();
    } catch (err) {
      setAlertError((err as Error).message);
      setPendingAction({ id, action, type });
      setAlertOpen(true);
    } finally {
      setActionLoading(null);
    }
  };

  const handleActionRequest = (
    id: string,
    action: "sync" | "delete" | "sync-sub" | "delete-sub",
    type: "account" | "subscription",
  ) => {
    if (action === "sync" || action === "sync-sub") {
      executeAction(id, action, type);
      return;
    }
    setPendingAction({ id, action, type });
    setAlertError(null);
    setAlertOpen(true);
  };

  const handleAlertConfirm = () => {
    setAlertOpen(false);
    if (pendingAction) {
      executeAction(pendingAction.id, pendingAction.action, pendingAction.type);
    }
  };

  const handleToggleAccountEnabled = async (accountId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/calendar/accounts/${accountId}`, { enabled });
      await loadData();
    } catch {
      // Ignore
    }
  };

  const handleToggleSubscriptionEnabled = async (subscriptionId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/calendar/subscriptions/${subscriptionId}`, { enabled });
      await loadData();
    } catch {
      // Ignore
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
    } catch {
      // Ignore
    } finally {
      setActionLoading(null);
    }
  };

  const totalEvents = accounts.reduce(
    (sum, acc) => sum + acc.calendars.reduce((c, cal) => c + cal.eventCount, 0),
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
                <div className="border-border/50 bg-background/40 overflow-hidden rounded-2xl border">
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
                    <div className="border-border/50 border-t">
                      <button
                        className="flex w-full items-center gap-2 px-4 py-2 text-xs transition-colors hover:bg-white/10"
                        onClick={() => toggleExpanded(localAccount.id)}
                      >
                        {expandedAccounts.has(localAccount.id) ? (
                          <ChevronDown className="text-muted-foreground h-3 w-3" />
                        ) : (
                          <ChevronRight className="text-muted-foreground h-3 w-3" />
                        )}
                        <span className="text-muted-foreground">
                          {expandedAccounts.has(localAccount.id) ? "Hide" : "Show"}{" "}
                          {localAccount.calendars.length} calendar
                          {localAccount.calendars.length !== 1 ? "s" : ""}
                        </span>
                      </button>

                      {expandedAccounts.has(localAccount.id) && (
                        <div className="border-border/50 border-t px-4 py-2">
                          {localAccount.calendars.map((cal) => (
                            <div key={cal.id} className="flex items-center gap-2 py-1.5">
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: cal.color || "var(--muted-foreground)",
                                }}
                              />
                              <span className="text-xs">{cal.name}</span>
                              <span className="text-muted-foreground/60 text-[10px]">
                                {cal.eventCount} events
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* CalDAV accounts */}
              {caldavAccounts.map((account) => {
                const isBusy =
                  actionLoading === "sync:" + account.id || actionLoading === "sync-all";
                const isExpanded = expandedAccounts.has(account.id);

                return (
                  <div
                    key={account.id}
                    className="border-border/50 bg-background/40 overflow-hidden rounded-2xl border"
                  >
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
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => handleActionRequest(account.id, "sync", "account")}
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
                              onClick={() => handleActionRequest(account.id, "delete", "account")}
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
                      <div className="border-border/50 border-t">
                        <button
                          className="flex w-full items-center gap-2 px-4 py-2 text-xs transition-colors hover:bg-white/10"
                          onClick={() => toggleExpanded(account.id)}
                        >
                          {isExpanded ? (
                            <ChevronDown className="text-muted-foreground h-3 w-3" />
                          ) : (
                            <ChevronRight className="text-muted-foreground h-3 w-3" />
                          )}
                          <span className="text-muted-foreground">
                            {isExpanded ? "Hide" : "Show"} {account.calendars.length} calendar
                            {account.calendars.length !== 1 ? "s" : ""}
                          </span>
                        </button>

                        {isExpanded && (
                          <div className="border-border/50 border-t px-4 py-2">
                            {account.calendars.map((cal) => (
                              <div key={cal.id} className="flex items-center gap-2 py-1.5">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{
                                    backgroundColor: cal.color || "var(--muted-foreground)",
                                  }}
                                />
                                <span className="text-xs">{cal.name}</span>
                                <span className="text-muted-foreground/60 text-[10px]">
                                  {cal.eventCount} events
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sync result */}
                    {syncResult?.id === account.id && (
                      <div className="text-muted-foreground border-border/50 border-t px-4 py-2 text-xs">
                        {syncResult.created > 0 && `${syncResult.created} new · `}
                        {syncResult.updated > 0 && `${syncResult.updated} updated · `}
                        {syncResult.deleted > 0 && `${syncResult.deleted} removed · `}
                        {syncResult.created === 0 &&
                          syncResult.updated === 0 &&
                          syncResult.deleted === 0 &&
                          "No changes"}
                      </div>
                    )}
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
              onClick={() => setSubscriptionDialogOpen(true)}
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
                  <>
                    <div
                      key={sub.id}
                      className="border-border/50 bg-background/40 flex items-center justify-between rounded-2xl border p-4"
                    >
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
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                handleActionRequest(sub.id, "sync-sub", "subscription")
                              }
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
                                handleActionRequest(sub.id, "delete-sub", "subscription")
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
                    {syncResult?.id === sub.id && (
                      <div className="text-muted-foreground -mt-1 px-4 text-xs">
                        {syncResult.parsed !== null && `(${syncResult.parsed} parsed) · `}
                        {syncResult.created > 0 && `${syncResult.created} new · `}
                        {syncResult.updated > 0 && `${syncResult.updated} updated · `}
                        {syncResult.deleted > 0 && `${syncResult.deleted} removed · `}
                        {syncResult.created === 0 &&
                          syncResult.updated === 0 &&
                          syncResult.deleted === 0 &&
                          (syncResult.parsed ?? 0) === 0 &&
                          "No changes"}
                      </div>
                    )}
                  </>
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
        onOpenChange={setSubscriptionDialogOpen}
        accounts={accounts}
        onSuccess={loadData}
      />

      {/* Confirmation / Error Alert Dialog */}
      <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {alertError
                ? "Error"
                : pendingAction?.type === "account"
                  ? "Delete Account"
                  : "Remove Subscription"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {alertError
                ? alertError
                : pendingAction?.type === "account"
                  ? "Delete this calendar account and all its synced events? This cannot be undone."
                  : "Remove this subscription and its synced events? This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {alertError ? (
              <AlertDialogAction onClick={() => setAlertOpen(false)}>OK</AlertDialogAction>
            ) : (
              <>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleAlertConfirm} variant="destructive">
                  {pendingAction?.type === "account" ? "Delete" : "Remove"}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
