"use client";

import { useState, useEffect } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Mail,
  Loader2,
  Plus,
  CheckCircle,
  AlertCircle,
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
import { AccountDialog } from "@/components/mail/account-dialog";
import type { UserSettings, EmailAccount } from "../types";

interface EmailTabProps {
  settings: UserSettings | null;
  onSettingsChange: (settings: UserSettings) => void;
  onSave: () => Promise<void>;
}

export function EmailTab({ settings, onSettingsChange, onSave }: EmailTabProps) {
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

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

  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const handleAction = async (accountId: string, action: "sync" | "full-refresh" | "delete") => {
    if (action === "delete" && !confirm("Delete this email account and all its synced messages?")) {
      return;
    }
    if (
      action === "full-refresh" &&
      !confirm("This will delete all synced emails and re-download everything. Continue?")
    ) {
      return;
    }

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
        alert(data.error || "Action failed");
      }
      await loadAccounts();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setActionLoading(null);
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
                        <DropdownMenuTrigger>
                          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={isBusy}>
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handleAction(account.id, "sync")}
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
                            onClick={() => handleAction(account.id, "full-refresh")}
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
                            onClick={() => handleAction(account.id, "delete")}
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

          <Separator />

          <div className="space-y-2">
            <Label>Sync Interval</Label>
            <Select
              value={String(settings?.emailSyncInterval ?? 300)}
              onValueChange={(v) => {
                if (v && settings) {
                  onSettingsChange({ ...settings, emailSyncInterval: parseInt(v) });
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="60">Every minute</SelectItem>
                <SelectItem value="300">Every 5 minutes</SelectItem>
                <SelectItem value="900">Every 15 minutes</SelectItem>
                <SelectItem value="1800">Every 30 minutes</SelectItem>
                <SelectItem value="3600">Every hour</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={onSave}>
              <CheckCircle className="mr-2 h-4 w-4" />
              Save
            </Button>
            {saveStatus === "success" && (
              <span className="flex items-center gap-1 text-sm text-emerald-500">
                <CheckCircle className="h-4 w-4" />
                Saved
              </span>
            )}
            {saveStatus === "error" && (
              <span className="flex items-center gap-1 text-sm text-red-500">
                <AlertCircle className="h-4 w-4" />
                Failed
              </span>
            )}
          </div>
        </GlassPanelContent>
      </GlassPanel>

      <AccountDialog
        open={accountDialogOpen}
        onOpenChange={setAccountDialogOpen}
        onSuccess={loadAccounts}
      />
    </>
  );
}
