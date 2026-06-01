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
import { Mail, Loader2, Plus, CheckCircle, AlertCircle, RefreshCw } from "lucide-react";
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
  const [syncing, setSyncing] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  useEffect(() => {
    fetch("/api/email/accounts")
      .then((r) => r.json())
      .then((data) => {
        setEmailAccounts(data.accounts ?? []);
        setEmailLoading(false);
      })
      .catch(() => setEmailLoading(false));
  }, []);

  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const handleSync = async (accountId: string) => {
    setSyncing(accountId);
    try {
      await fetch(`/api/email/accounts/${accountId}/sync`, { method: "POST" });
      const res = await fetch("/api/email/accounts");
      const data = await res.json();
      setEmailAccounts(data.accounts ?? []);
    } finally {
      setSyncing(null);
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
            <Button size="sm" onClick={() => setAccountDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Account
            </Button>
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
              {emailAccounts.map((account) => (
                <div
                  key={account.id}
                  className="border-border/50 bg-background/40 flex items-center justify-between rounded-2xl border p-4"
                >
                  <div>
                    <p className="text-sm font-medium">{account.email}</p>
                    <p className="text-muted-foreground text-xs">
                      {account.messageCount} messages
                      {account.lastSyncedAt
                        ? ` · Last synced ${new Date(account.lastSyncedAt).toLocaleString()}`
                        : " · Never synced"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={account.enabled} disabled />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleSync(account.id)}
                      disabled={syncing === account.id}
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${syncing === account.id ? "animate-spin" : ""}`}
                      />
                    </Button>
                  </div>
                </div>
              ))}
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

      <AccountDialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen} />
    </>
  );
}
