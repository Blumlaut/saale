"use client";

import { useState, useEffect } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import {
  Mail,
  Loader2,
  Plus,
  Pencil,
  RefreshCw,
  Trash2,
  AlertTriangle,
  MoreVertical,
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
import { AccountSheet } from "@/components/mail/account-sheet";
import type { EmailAccount } from "../types";

export function EmailSection() {
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);
  const [alertOpen, setAlertOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    accountId: string;
    action: "sync" | "full-refresh" | "delete";
  } | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);

  const loadAccounts = async () => {
    try {
      const data = await fetchJson<{ accounts: EmailAccount[] }>("/api/email/accounts");
      setEmailAccounts(data.accounts ?? []);
    } catch (err) {
      // Logged, not swallowed: a failing endpoint used to render as "No email
      // accounts connected", which reads like the user never added one.
      console.error("Failed to load email accounts:", err);
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
      const url =
        action === "delete"
          ? `/api/email/accounts/${accountId}`
          : `/api/email/accounts/${accountId}/${action === "full-refresh" ? "full-refresh" : "sync"}`;

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

  const handleToggleEnabled = async (accountId: string, enabled: boolean) => {
    try {
      await patchJson(`/api/email/accounts/${accountId}`, { enabled });
      await loadAccounts();
    } catch (err) {
      console.error(`Failed to set email account ${accountId} enabled=${enabled}:`, err);
    }
  };

  const handleSyncAll = async () => {
    setActionLoading("sync-all");
    try {
      await Promise.all(
        emailAccounts.map((acc) => postJson(`/api/email/accounts/${acc.id}/sync`, {})),
      );
      await loadAccounts();
    } catch (err) {
      console.error("Failed to sync all email accounts:", err);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <>
      <GlassPanel className="border-0">
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
                  variant="secondary"
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
              <Button
                size="sm"
                onClick={() => {
                  setEditingAccount(null);
                  setAccountDialogOpen(true);
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Account
              </Button>
            </div>
          </div>

          {emailLoading ? (
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          ) : emailAccounts.length === 0 ? (
            <div className="bg-muted border-border/30 flex flex-col items-center rounded-2xl border border-dashed p-8 text-center">
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
                    className="bg-muted flex items-center justify-between rounded-2xl border-0 p-4"
                  >
                    <div className="min-w-0 flex-1">
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
                      {account.lastSyncError && (
                        <p className="text-destructive mt-1 flex items-start gap-1.5 text-xs">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 break-words">
                            Sync failed
                            {account.lastSyncErrorAt
                              ? ` (${new Date(account.lastSyncErrorAt).toLocaleString()})`
                              : ""}
                            : {account.lastSyncError}
                          </span>
                        </p>
                      )}
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
                            onClick={() => {
                              setEditingAccount(account);
                              setAccountDialogOpen(true);
                            }}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit Settings
                          </DropdownMenuItem>
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

      <AccountSheet
        open={accountDialogOpen}
        onOpenChange={setAccountDialogOpen}
        account={editingAccount}
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
