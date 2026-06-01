"use client";

import { useState, useEffect } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Mail, Loader2, Plus, RefreshCw, Trash2, AlertTriangle, MoreVertical } from "lucide-react";
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
import { AccountDialog } from "@/components/mail/account-dialog";
import type { EmailAccount } from "../types";

export function EmailTab() {
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    accountId: string;
    action: "sync" | "full-refresh" | "delete";
  } | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);

  const loadAccounts = async () => {
    try {
      const res = await fetch("/api/email/accounts");
      const data = await res.json();
      setEmailAccounts(data.accounts ?? []);
    } catch {
      // Ignore
    }
  };

  useEffect(() => {
    loadAccounts().then(() => setEmailLoading(false));
  }, []);

  const handleActionRequest = (accountId: string, action: "sync" | "full-refresh" | "delete") => {
    if (action === "sync") {
      executeAction(accountId, action);
      return;
    }
    setPendingAction({ accountId, action });
    setAlertError(null);
    setAlertOpen(true);
  };

  const executeAction = async (accountId: string, action: "sync" | "full-refresh" | "delete") => {
    setActionLoading(action + ":" + accountId);
    try {
      const method = action === "delete" ? "DELETE" : "POST";
      const url =
        action === "delete"
          ? `/api/email/accounts/${accountId}`
          : `/api/email/accounts/${accountId}/${action === "full-refresh" ? "full-refresh" : "sync"}`;

      const res = await fetch(url, { method });
      if (!res.ok) {
        const data = await res.json();
        setAlertError(data.error || "Action failed");
        setPendingAction({ accountId, action });
        setAlertOpen(true);
        return;
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

  const handleToggleEnabled = async (accountId: string, enabled: boolean) => {
    try {
      await fetch(`/api/email/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await loadAccounts();
    } catch {
      // Ignore
    }
  };

  const handleSyncAll = async () => {
    setActionLoading("sync-all");
    try {
      await Promise.all(
        emailAccounts.map((acc) => fetch(`/api/email/accounts/${acc.id}/sync`, { method: "POST" })),
      );
      await loadAccounts();
    } catch {
      // Ignore
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <GlassPanel>
        <GlassPanelContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <Mail className="h-5 w-5" />
                Email Accounts
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Manage your connected email accounts
              </p>
            </div>
            <div className="flex items-center gap-2">
              {emailAccounts.length > 0 && (
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

          {emailLoading ? (
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          ) : emailAccounts.length === 0 ? (
            <div className="border-border/50 rounded-2xl border border-dashed p-8 text-center">
              <Mail className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                No email accounts connected. Add one to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {emailAccounts.map((account) => {
                const isBusy =
                  actionLoading === "sync:" + account.id ||
                  actionLoading === "full-refresh:" + account.id ||
                  actionLoading === "sync-all";

                return (
                  <div
                    key={account.id}
                    className="border-border/50 bg-background/40 flex items-center justify-between rounded-2xl border p-4"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">{account.email}</p>
                        {!account.enabled && (
                          <span className="text-muted-foreground bg-muted/50 rounded-full px-2 py-0.5 text-[10px]">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {account.messageCount} messages
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
                          onCheckedChange={(v) => handleToggleEnabled(account.id, v)}
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
                            onClick={() => handleActionRequest(account.id, "full-refresh")}
                            disabled={isBusy}
                          >
                            {actionLoading === "full-refresh:" + account.id ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <AlertTriangle className="mr-2 h-4 w-4" />
                            )}
                            Full Refresh
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
                );
              })}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <AccountDialog
        open={accountDialogOpen}
        onOpenChange={setAccountDialogOpen}
        onSuccess={loadAccounts}
      />

      {/* Confirmation / Error Alert Dialog */}
      <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {alertError
                ? "Error"
                : pendingAction?.action === "delete"
                  ? "Delete Account"
                  : "Full Refresh"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {alertError
                ? alertError
                : pendingAction?.action === "delete"
                  ? "Delete this email account and all its synced messages? This cannot be undone."
                  : "This will delete all synced emails and re-download everything. Continue?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {alertError ? (
              <AlertDialogAction onClick={() => setAlertOpen(false)}>OK</AlertDialogAction>
            ) : (
              <>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleAlertConfirm}
                  variant={pendingAction?.action === "delete" ? "destructive" : "default"}
                >
                  {pendingAction?.action === "delete" ? "Delete" : "Continue"}
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
