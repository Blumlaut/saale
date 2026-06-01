"use client";

import { useEffect, useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Settings as SettingsIcon,
  Mail,
  Bot,
  Palette,
  Loader2,
  CheckCircle,
  AlertCircle,
  Plus,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { useTheme } from "next-themes";
import { AccountDialog } from "@/components/mail/account-dialog";

interface UserSettings {
  defaultModelProvider: string;
  defaultModelName: string;
  defaultThinkingLevel: string;
  theme: string;
  emailSyncInterval: number;
}

interface EmailAccount {
  id: string;
  email: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  messageCount: number;
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  useEffect(() => {
    loadSettings();
    loadAccounts();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (res.ok) {
        const data = await res.json();
        setSettings(data.settings);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  };

  const loadAccounts = async () => {
    try {
      const res = await fetch("/api/email/accounts");
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts);
      }
    } catch {
      // Ignore
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus("idle");

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (res.ok) {
        setSaveStatus("success");
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async (accountId: string) => {
    setSyncingId(accountId);
    try {
      const res = await fetch(`/api/email/accounts/${accountId}/sync`, {
        method: "POST",
      });
      if (res.ok) {
        loadAccounts();
      }
    } catch {
      // Ignore
    } finally {
      setSyncingId(null);
    }
  };

  const handleToggleAccount = async (accountId: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/email/accounts/${accountId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        setAccounts((prev) =>
          prev.map((a) => (a.id === accountId ? { ...a, enabled } : a)),
        );
      }
    } catch {
      // Ignore
    }
  };

  const handleDeleteAccount = async (accountId: string) => {
    try {
      const res = await fetch(`/api/email/accounts/${accountId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setAccounts((prev) => prev.filter((a) => a.id !== accountId));
      }
    } catch {
      // Ignore
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl leading-tight font-semibold tracking-tight">
            Settings
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage your preferences
          </p>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : saveStatus === "success" ? (
            <>
              <CheckCircle className="mr-2 h-4 w-4" />
              Saved
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>

      {/* Save status */}
      {saveStatus === "error" && (
        <div className="text-destructive flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-3 text-sm">
          <AlertCircle className="h-4 w-4" />
          Failed to save settings
        </div>
      )}

      {/* Settings tabs */}
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="grid w-full grid-cols-3 lg:w-96">
          <TabsTrigger value="general">
            <Bot className="mr-2 h-4 w-4" />
            AI & Models
          </TabsTrigger>
          <TabsTrigger value="email">
            <Mail className="mr-2 h-4 w-4" />
            Email
          </TabsTrigger>
          <TabsTrigger value="appearance">
            <Palette className="mr-2 h-4 w-4" />
            Appearance
          </TabsTrigger>
        </TabsList>

        {/* AI & Models */}
        <TabsContent value="general">
          <GlassPanel>
            <GlassPanelContent className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Default Model Provider</Label>
                  <Select
                    value={settings?.defaultModelProvider ?? ""}
                    onValueChange={(v) =>
                      setSettings((prev) =>
                        prev ? { ...prev, defaultModelProvider: v as string } : prev,
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="google">Google</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Default Model</Label>
                  <Input
                    value={settings?.defaultModelName ?? ""}
                    onChange={(e) =>
                      setSettings((prev) =>
                        prev ? { ...prev, defaultModelName: e.target.value } : prev,
                      )
                    }
                    placeholder="claude-sonnet-4-5-20250514"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Default Thinking Level</Label>
                  <Select
                    value={settings?.defaultThinkingLevel ?? "off"}
                    onValueChange={(v) =>
                      setSettings((prev) =>
                        prev ? { ...prev, defaultThinkingLevel: v as string } : prev,
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="minimal">Minimal</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </GlassPanelContent>
          </GlassPanel>
        </TabsContent>

        {/* Email */}
        <TabsContent value="email">
          <GlassPanel>
            <GlassPanelContent className="space-y-6">
              {/* Sync interval */}
              <div className="space-y-2">
                <Label>Sync Interval (seconds)</Label>
                <Input
                  type="number"
                  value={settings?.emailSyncInterval ?? 300}
                  onChange={(e) =>
                    setSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            emailSyncInterval: parseInt(e.target.value) || 300,
                          }
                        : prev,
                    )
                  }
                />
                <p className="text-muted-foreground text-xs">
                  How often to sync email accounts automatically
                </p>
              </div>

              <Separator />

              {/* Accounts */}
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Email Accounts</h3>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAddAccount(true)}
                >
                  <Plus className="mr-2 h-3 w-3" />
                  Add Account
                </Button>
              </div>

              {accounts.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No email accounts connected
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {accounts.map((acc) => (
                    <div
                      key={acc.id}
                      className="flex items-center justify-between rounded-xl border bg-white/20 px-4 py-3 dark:bg-white/5"
                    >
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={acc.enabled}
                          onCheckedChange={(checked) =>
                            handleToggleAccount(acc.id, checked)
                          }
                        />
                        <div>
                          <div className="text-sm font-medium">{acc.email}</div>
                          <div className="text-muted-foreground text-xs">
                            {acc.messageCount} messages
                            {acc.lastSyncedAt &&
                              ` · Last synced ${new Date(acc.lastSyncedAt).toLocaleString()}`}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleSync(acc.id)}
                          disabled={syncingId === acc.id}
                        >
                          {syncingId === acc.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3 w-3" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleDeleteAccount(acc.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </GlassPanelContent>
          </GlassPanel>
        </TabsContent>

        {/* Appearance */}
        <TabsContent value="appearance">
          <GlassPanel>
            <GlassPanelContent className="space-y-6">
              <div className="space-y-2">
                <Label>Theme</Label>
                <div className="flex gap-2">
                  {(["light", "dark", "system"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      className={cn(
                        "flex-1 rounded-xl border px-4 py-3 text-sm font-medium transition-colors hover:bg-white/20 dark:hover:bg-white/5",
                        theme === t && "border-primary bg-white/20 dark:bg-white/5",
                      )}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </GlassPanelContent>
          </GlassPanel>
        </TabsContent>
      </Tabs>

      {/* Add account dialog */}
      <AccountDialog
        open={showAddAccount}
        onOpenChange={setShowAddAccount}
        onSuccess={loadAccounts}
      />
    </div>
  );
}

import { cn } from "@/lib/utils";
