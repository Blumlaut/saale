"use client";

import { useEffect, useState, useCallback } from "react";
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
  Key,
  Eye,
  EyeOff,
  Shield,
  Sparkles,
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

interface ProviderInfo {
  id: string;
  name: string;
}

interface ConfiguredProvider {
  id: string;
  provider: string;
  label: string;
  configured: boolean;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

interface AvailableModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number };
}

interface AvailableProvider {
  id: string;
  name: string;
  modelCount: number;
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Email state
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);
  const [emailLoading, setEmailLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);

  // Providers state
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [addingProvider, setAddingProvider] = useState(false);
  const [newProvider, setNewProvider] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [providerStatus, setProviderStatus] = useState<"idle" | "success" | "error">("idle");
  const [modelDiscoveryInfo, setModelDiscoveryInfo] = useState<{ count: number; error?: string } | null>(null);

  // Available models (from Pi SDK)
  const [availableModels, setAvailableModels] = useState<Record<string, AvailableModel[]>>({});
  const [availableModelProviders, setAvailableModelProviders] = useState<AvailableProvider[]>([]);

  // Load settings
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setSettings(data.settings);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Load email accounts
  useEffect(() => {
    fetch("/api/email/accounts")
      .then((r) => r.json())
      .then((data) => {
        setEmailAccounts(data.accounts ?? []);
        setEmailLoading(false);
      })
      .catch(() => setEmailLoading(false));
  }, []);

  // Load providers
  useEffect(() => {
    loadProviders();
  }, []);

  // Load available models whenever providers change
  useEffect(() => {
    if (!providersLoading) {
      loadModels();
    }
  }, [providers, providersLoading]);

  const loadProviders = async () => {
    try {
      const data = await fetch("/api/providers").then((r) => r.json());
      setProviders(data.providers ?? []);
      setAvailableProviders(data.availableProviders ?? []);
    } finally {
      setProvidersLoading(false);
    }
  };

  const loadModels = async () => {
    try {
      const data = await fetch("/api/providers/models").then((r) => r.json());
      setAvailableModels(data.models ?? {});
      setAvailableModelProviders(data.providers ?? []);
    } catch {
      // No models available yet
    }
  };

  // Auto-clear save status
  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  useEffect(() => {
    if (providerStatus !== "idle") {
      const timer = setTimeout(() => setProviderStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [providerStatus]);

  const handleSaveSettings = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        setSaveStatus("success");
      } else {
        setSaveStatus("error");
      }
    } catch {
      setSaveStatus("error");
    }
    setSaving(false);
  }, [settings]);

  const handleAddProvider = useCallback(async () => {
    if (!newProvider) return;
    if (newProvider === "custom" && !newBaseUrl) return;
    setAddingProvider(true);
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: newProvider,
          apiKey: newApiKey,
          label: newLabel,
          baseUrl: newProvider === "custom" ? newBaseUrl : undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setProviderStatus("success");
        setNewApiKey("");
        setNewLabel("");
        setNewBaseUrl("");
        setNewProvider("");

        // Show model discovery info
        if (data.modelCount !== undefined) {
          setModelDiscoveryInfo({ count: data.modelCount, error: data.modelError });
          setTimeout(() => setModelDiscoveryInfo(null), 8000);
        }

        // Reload providers and models
        const providersData = await fetch("/api/providers").then((r) => r.json());
        setProviders(providersData.providers ?? []);
        // Reload available models
        const modelsData = await fetch("/api/providers/models").then((r) => r.json());
        setAvailableModels(modelsData.models ?? {});
        setAvailableModelProviders(modelsData.providers ?? []);
      } else {
        setProviderStatus("error");
      }
    } catch {
      setProviderStatus("error");
    }
    setAddingProvider(false);
  }, [newProvider, newApiKey, newLabel]);

  const handleRemoveProvider = useCallback(async (provider: string) => {
    try {
      const res = await fetch(`/api/providers?provider=${encodeURIComponent(provider)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setProviders((prev) => prev.filter((p) => p.provider !== provider));
      }
    } catch {
      // Silently fail
    }
  }, []);

  const handleSync = useCallback(async (accountId: string) => {
    setSyncing(accountId);
    try {
      await fetch(`/api/email/accounts/${accountId}/sync`, { method: "POST" });
      // Reload accounts
      const res = await fetch("/api/email/accounts");
      const data = await res.json();
      setEmailAccounts(data.accounts ?? []);
    } finally {
      setSyncing(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <GlassPanel className="rounded-xl p-2">
          <SettingsIcon className="h-5 w-5 text-muted-foreground" />
        </GlassPanel>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure your AI providers, email accounts, and preferences
          </p>
        </div>
      </div>

      <Tabs defaultValue="providers" className="space-y-6">
        <TabsList>
          <TabsTrigger value="providers" className="gap-2">
            <Key className="h-4 w-4" />
            Model Providers
          </TabsTrigger>
          <TabsTrigger value="ai" className="gap-2">
            <Bot className="h-4 w-4" />
            AI & Models
          </TabsTrigger>
          <TabsTrigger value="email" className="gap-2">
            <Mail className="h-4 w-4" />
            Email
          </TabsTrigger>
          <TabsTrigger value="appearance" className="gap-2">
            <Palette className="h-4 w-4" />
            Appearance
          </TabsTrigger>
        </TabsList>

        {/* ─── Model Providers Tab ─────────────────────────────── */}
        <TabsContent value="providers" className="space-y-6">
          <GlassPanel>
            <GlassPanelContent className="space-y-6">
              <div>
                <h3 className="text-lg font-medium flex items-center gap-2">
                  <Key className="h-5 w-5" />
                  API Keys
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Add your API keys to enable AI model providers. Keys are encrypted at rest.
                </p>
              </div>

              {/* Add new provider */}
              <div className="space-y-4 rounded-2xl border border-border/50 bg-background/40 p-5">
                <h4 className="text-sm font-medium">Add Provider</h4>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="provider-select">Provider</Label>
                    <Select value={newProvider} onValueChange={(v) => setNewProvider(v ?? "")}>
                      <SelectTrigger id="provider-select">
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableProviders.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="api-key">API Key <span className="text-muted-foreground font-normal">(optional)</span></Label>
                    <div className="relative">
                      <Input
                        id="api-key"
                        type={showApiKey ? "text" : "password"}
                        placeholder="sk-... or leave empty for local servers"
                        value={newApiKey}
                        onChange={(e) => setNewApiKey(e.target.value)}
                        className="pr-10 font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showApiKey ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Base URL for custom providers */}
                {newProvider === "custom" && (
                  <div className="space-y-2">
                    <Label htmlFor="base-url">Base URL</Label>
                    <Input
                      id="base-url"
                      placeholder="http://ollama.home.blumlaut.me/v1"
                      value={newBaseUrl}
                      onChange={(e) => setNewBaseUrl(e.target.value)}
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      Base URL including /v1 path, e.g. https://api.openai.com/v1
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="provider-label">Label (optional)</Label>
                  <Input
                    id="provider-label"
                    placeholder="e.g. Work account"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    onClick={handleAddProvider}
                    disabled={addingProvider || !newProvider || (newProvider === "custom" && !newBaseUrl)}
                  >
                    {addingProvider ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-2 h-4 w-4" />
                    )}
                    Add Key
                  </Button>
                  {providerStatus === "success" && (
                    <span className="flex items-center gap-1 text-sm text-emerald-500">
                      <CheckCircle className="h-4 w-4" />
                      Saved
                    </span>
                  )}
                  {providerStatus === "error" && (
                    <span className="flex items-center gap-1 text-sm text-red-500">
                      <AlertCircle className="h-4 w-4" />
                      Failed
                    </span>
                  )}
                  {modelDiscoveryInfo && modelDiscoveryInfo.count > 0 && (
                    <span className="flex items-center gap-1 text-sm text-blue-500">
                      <Sparkles className="h-4 w-4" />
                      {modelDiscoveryInfo.count} models discovered
                    </span>
                  )}
                  {modelDiscoveryInfo && modelDiscoveryInfo.error && (
                    <span className="flex items-center gap-1 text-sm text-amber-500">
                      <AlertCircle className="h-4 w-4" />
                      {modelDiscoveryInfo.error}
                    </span>
                  )}
                </div>
              </div>

              {/* Configured providers */}
              {providersLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : providers.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/50 p-8 text-center">
                  <Shield className="mx-auto h-8 w-8 text-muted-foreground/50" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    No API keys configured yet. Add one above to get started.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {providers.map((p) => (
                    <div
                      key={p.provider}
                      className="flex items-center justify-between rounded-2xl border border-border/50 bg-background/40 p-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                          <Key className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">{p.displayName}</p>
                          <p className="text-xs text-muted-foreground">
                            {p.label || p.provider}
                            {p.label ? ` (${p.provider})` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-500">
                          <CheckCircle className="h-3 w-3" />
                          Configured
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-red-500"
                          onClick={() => handleRemoveProvider(p.provider)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Info */}
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  <Shield className="mr-1 inline h-3.5 w-3.5" />
                  API keys are encrypted with AES-256-GCM before storage. They are only decrypted in memory when creating an AI session.
                </p>
              </div>
            </GlassPanelContent>
          </GlassPanel>
        </TabsContent>

        {/* ─── AI & Models Tab ─────────────────────────────────── */}
        <TabsContent value="ai" className="space-y-6">
          <GlassPanel>
            <GlassPanelContent className="space-y-6">
              <div>
                <h3 className="text-lg font-medium flex items-center gap-2">
                  <Bot className="h-5 w-5" />
                  Default Model
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Choose the default model for new chat sessions.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="model-provider">Provider</Label>
                  <Select
                    value={settings?.defaultModelProvider ?? ""}
                    onValueChange={(v) => {
                      if (v) setSettings((s) => s ? { ...s, defaultModelProvider: v } : s);
                    }}
                  >
                    <SelectTrigger id="model-provider">
                      <SelectValue placeholder="Select provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableModelProviders.length === 0 && (
                        <SelectItem value="none" disabled>
                          Add an API key first
                        </SelectItem>
                      )}
                      {availableModelProviders.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} ({p.modelCount} models)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="model-name">Model</Label>
                  <Select
                    value={settings?.defaultModelName ?? ""}
                    onValueChange={(v) => {
                      if (v) setSettings((s) => s ? { ...s, defaultModelName: v } : s);
                    }}
                  >
                    <SelectTrigger id="model-name">
                      <SelectValue placeholder="Select model" />
                    </SelectTrigger>
                    <SelectContent>
                      {settings?.defaultModelProvider && availableModels[settings.defaultModelProvider] ? (
                        availableModels[settings.defaultModelProvider]
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}
                              {m.reasoning ? " ✦" : ""}
                            </SelectItem>
                          ))
                      ) : (
                        <SelectItem value="none" disabled>
                          {settings?.defaultModelProvider
                            ? "No models available"
                            : "Select a provider first"}
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="thinking-level">Thinking Level</Label>
                <Select
                  value={settings?.defaultThinkingLevel ?? "off"}
                  onValueChange={(v) => {
                    if (v) setSettings((s) => s ? { ...s, defaultThinkingLevel: v } : s);
                  }}
                >
                  <SelectTrigger id="thinking-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="minimal">Minimal</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="xhigh">X-High</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-3">
                <Button onClick={handleSaveSettings} disabled={saving}>
                  {saving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="mr-2 h-4 w-4" />
                  )}
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
        </TabsContent>

        {/* ─── Email Tab ───────────────────────────────────────── */}
        <TabsContent value="email" className="space-y-6">
          <GlassPanel>
            <GlassPanelContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-medium flex items-center gap-2">
                    <Mail className="h-5 w-5" />
                    Email Accounts
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Manage your connected email accounts
                  </p>
                </div>
                <Button size="sm" onClick={() => setAccountDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Account
                </Button>
              </div>

              {emailLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : emailAccounts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/50 p-8 text-center">
                  <Mail className="mx-auto h-8 w-8 text-muted-foreground/50" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    No email accounts connected. Add one to get started.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {emailAccounts.map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center justify-between rounded-2xl border border-border/50 bg-background/40 p-4"
                    >
                      <div>
                        <p className="text-sm font-medium">{account.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {account.messageCount} messages
                          {account.lastSyncedAt
                            ? ` · Last synced ${new Date(account.lastSyncedAt).toLocaleString()}`
                            : " · Never synced"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={account.enabled}
                          disabled
                        />
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
                    if (v) setSettings((s) => s ? { ...s, emailSyncInterval: parseInt(v) } : s);
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
            </GlassPanelContent>
          </GlassPanel>
        </TabsContent>

        {/* ─── Appearance Tab ──────────────────────────────────── */}
        <TabsContent value="appearance" className="space-y-6">
          <GlassPanel>
            <GlassPanelContent className="space-y-6">
              <div>
                <h3 className="text-lg font-medium flex items-center gap-2">
                  <Palette className="h-5 w-5" />
                  Appearance
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Customize the look and feel of Saale
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Theme</Label>
                  <div className="grid grid-cols-3 gap-3">
                    {(["light", "dark", "system"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setTheme(t)}
                        className={`rounded-2xl border-2 p-4 text-center transition-all ${
                          theme === t
                            ? "border-primary bg-primary/5"
                            : "border-border/50 hover:border-border"
                        }`}
                      >
                        <p className="text-sm font-medium capitalize">{t}</p>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </GlassPanelContent>
          </GlassPanel>
        </TabsContent>
      </Tabs>

      {/* Account dialog */}
      <AccountDialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen} />
    </div>
  );
}
