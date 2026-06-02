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
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
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

interface CalendarAccount {
  id: string;
  name: string;
  serverUrl: string;
  username: string;
  authMethod: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export function CalendarTab() {
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    accountId: string;
    action: "sync" | "delete";
  } | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());

  const loadAccounts = async () => {
    try {
      const data = await fetchJson<{ accounts: CalendarAccount[] }>("/api/calendar/accounts");
      setAccounts(data.accounts ?? []);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    loadAccounts().then(() => setLoading(false));
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

  const handleActionRequest = (accountId: string, action: "sync" | "delete") => {
    if (action === "sync") {
      executeAction(accountId, action);
      return;
    }
    setPendingAction({ accountId, action });
    setAlertError(null);
    setAlertOpen(true);
  };

  const executeAction = async (accountId: string, action: "sync" | "delete") => {
    setActionLoading(action + ":" + accountId);
    try {
      const url =
        action === "delete"
          ? `/api/calendar/accounts/${accountId}`
          : `/api/calendar/accounts/${accountId}/sync`;

      if (action === "delete") {
        await deleteJson(url);
      } else {
        await postJson(url, {});
      }
      await loadAccounts();
    } catch (err) {
      setAlertError((err as Error).message);
      setPendingAction({ accountId, action });
      setAlertOpen(true);
    } finally {
      setActionLoading(null);
    }
  };

  const handleAlertConfirm = () => {
    setAlertOpen(false);
    if (pendingAction) {
      executeAction(pendingAction.accountId, pendingAction.action);
    }
  };

  const handleToggleAccountEnabled = async (accountId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/calendar/accounts/${accountId}`, { enabled });
      await loadAccounts();
    } catch {
      // Ignore
    }
  };

  const handleToggleCalendarEnabled = async (calendarId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/calendar/calendars/${calendarId}`, { enabled });
      await loadAccounts();
    } catch {
      // Ignore
    }
  };

  const handleSyncAll = async () => {
    setActionLoading("sync-all");
    try {
      await Promise.all(
        accounts.map((acc) => postJson(`/api/calendar/accounts/${acc.id}/sync`, {})),
      );
      await loadAccounts();
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

  return (
    <>
      <GlassPanel>
        <GlassPanelContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <Calendar className="h-5 w-5" />
                Calendar Accounts
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Manage your CalDAV accounts and calendars
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
                Add Account
              </Button>
            </div>
          </div>

          {loading ? (
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          ) : accounts.length === 0 ? (
            <div className="border-border/50 rounded-2xl border border-dashed p-8 text-center">
              <Calendar className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                No calendar accounts connected. Add one to sync your CalDAV calendars.
              </p>
              <p className="text-muted-foreground/60 mt-1 text-xs">
                Supports iCloud, Nextcloud, Fastmail, and any CalDAV server
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {accounts.map((account) => {
                const isBusy =
                  actionLoading === "sync:" + account.id || actionLoading === "sync-all";
                const isExpanded = expandedAccounts.has(account.id);

                return (
                  <div
                    key={account.id}
                    className="border-border/50 bg-background/40 overflow-hidden rounded-2xl border"
                  >
                    {/* Account row */}
                    <div className="flex items-center justify-between p-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
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
                              onClick={() => handleActionRequest(account.id, "sync")}
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
                              onClick={() => handleActionRequest(account.id, "delete")}
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

                    {/* Calendars (expandable) */}
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
                              <div
                                key={cal.id}
                                className="flex items-center justify-between py-1.5"
                              >
                                <div className="flex items-center gap-2">
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
                                <div className="flex items-center gap-2">
                                  <span className="text-muted-foreground text-[10px]">
                                    {cal.enabled ? (
                                      <Eye className="h-3 w-3" />
                                    ) : (
                                      <EyeOff className="h-3 w-3" />
                                    )}
                                  </span>
                                  <Switch
                                    checked={cal.enabled}
                                    onCheckedChange={(v) => handleToggleCalendarEnabled(cal.id, v)}
                                    className="scale-75"
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <CalendarAccountDialog
        open={accountDialogOpen}
        onOpenChange={setAccountDialogOpen}
        onSuccess={loadAccounts}
      />

      {/* Confirmation / Error Alert Dialog */}
      <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{alertError ? "Error" : "Delete Account"}</AlertDialogTitle>
            <AlertDialogDescription>
              {alertError
                ? alertError
                : "Delete this calendar account and all its synced events? This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {alertError ? (
              <AlertDialogAction onClick={() => setAlertOpen(false)}>OK</AlertDialogAction>
            ) : (
              <>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleAlertConfirm} variant="destructive">
                  Delete
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
