"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchJson, patchJson, postJson, deleteJson } from "@/lib/http";
import { Bot, Key, Loader2, CheckCircle, AlertCircle, Plus, Trash2 } from "lucide-react";
import type { AvailableModel, AvailableProvider } from "@/app/dashboard/settings/types";

interface ProviderModelConfig {
  enabled: boolean;
  models?: string[];
}

interface AdminSettings {
  signupsEnabled: boolean;
  globalModelProvider: string;
  globalModelName: string;
  globalProviderModels: Record<string, ProviderModelConfig> | null;
}

interface ConfiguredProvider {
  id: string;
  provider: string;
  label: string;
  configured: boolean;
  displayName: string;
  baseUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function AdminModelsPage() {
  const [activeTab, setActiveTab] = useState<"providers" | "models">("providers");

  // ─── Providers tab state ───
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [availableProviders, setAvailableProviders] = useState<{ id: string; name: string }[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  // Add provider dialog
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [addProvider, setAddProvider] = useState("");
  const [addApiKey, setAddApiKey] = useState("");
  const [addBaseUrl, setAddBaseUrl] = useState("");
  const [adding, setAdding] = useState(false);

  // ─── Models tab state ───
  const [availableModels, setAvailableModels] = useState<Record<string, AvailableModel[]>>({});
  const [modelProviders, setModelProviders] = useState<AvailableProvider[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  const [adminSettings, setAdminSettings] = useState<AdminSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);

  // Provider toggle state
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>({});
  // Per-model toggle state
  const [modelEnabled, setModelEnabled] = useState<Record<string, Set<string>>>({});

  // ─── Save status ───
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Auto-clear save status
  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  // ─── Load providers ───
  const loadProviders = useCallback(async () => {
    try {
      const data = await fetchJson<{
        providers: ConfiguredProvider[];
        availableProviders: { id: string; name: string }[];
      }>("/api/admin/providers");
      setProviders(data.providers ?? []);
      setAvailableProviders(data.availableProviders ?? []);
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  // ─── Load models ───
  const loadModels = useCallback(async () => {
    try {
      const data = await fetchJson<{
        models: Record<string, AvailableModel[]>;
        providers: AvailableProvider[];
      }>("/api/providers/models");
      setAvailableModels(data.models ?? {});
      setModelProviders(data.providers ?? []);
    } catch {
      // No models available yet
    } finally {
      setModelsLoading(false);
    }
  }, []);

  // ─── Load admin settings ───
  const loadSettings = useCallback(async () => {
    try {
      const data = await fetchJson<{ settings: AdminSettings }>("/api/admin/settings");
      setAdminSettings(data.settings);

      // Initialize toggle states from admin settings
      const providerModels = data.settings.globalProviderModels ?? {};
      const enabled: Record<string, boolean> = {};
      const models: Record<string, Set<string>> = {};

      for (const [providerId, config] of Object.entries(providerModels)) {
        enabled[providerId] = (config as ProviderModelConfig).enabled ?? true;
        if ((config as ProviderModelConfig).models) {
          models[providerId] = new Set((config as ProviderModelConfig).models);
        }
      }

      setProviderEnabled(enabled);
      setModelEnabled(models);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadProviders(), loadModels(), loadSettings()]).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize providerEnabled for providers not in config (default to enabled)
  useEffect(() => {
    if (modelProviders.length > 0) {
      setProviderEnabled((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const prov of modelProviders) {
          if (!(prov.id in next)) {
            next[prov.id] = true;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [modelProviders]);

  // ─── Provider actions ───
  const handleAddProvider = async () => {
    if (!addProvider) return;
    setAdding(true);
    try {
      await postJson("/api/admin/providers", {
        provider: addProvider,
        apiKey: addApiKey || undefined,
        baseUrl: addBaseUrl || undefined,
      });
      setShowAddProvider(false);
      setAddProvider("");
      setAddApiKey("");
      setAddBaseUrl("");
      setSaveStatus("success");
      await Promise.all([loadProviders(), loadModels()]);
    } catch {
      setSaveStatus("error");
    }
    setAdding(false);
  };

  const handleRemoveProvider = async (providerId: string) => {
    try {
      await deleteJson(`/api/admin/providers?provider=${encodeURIComponent(providerId)}`);
      setSaveStatus("success");
      await Promise.all([loadProviders(), loadModels()]);
    } catch {
      setSaveStatus("error");
    }
  };

  // ─── Model toggle actions ───
  const handleProviderToggle = (providerId: string, enabled: boolean) => {
    setProviderEnabled((prev) => ({ ...prev, [providerId]: enabled }));
  };

  const handleModelToggle = (providerId: string, modelId: string, enabled: boolean) => {
    setModelEnabled((prev) => {
      const current = prev[providerId] ?? new Set();
      const next = new Set(current);
      if (enabled) {
        next.add(modelId);
      } else {
        next.delete(modelId);
      }
      return { ...prev, [providerId]: next };
    });
  };

  const handleSaveModels = useCallback(async () => {
    if (!adminSettings) return;
    setSaving(true);

    const globalProviderModels: Record<string, ProviderModelConfig> = {};
    for (const [providerId, enabled] of Object.entries(providerEnabled)) {
      globalProviderModels[providerId] = {
        enabled,
        models: Array.from(modelEnabled[providerId] ?? []),
      };
    }

    try {
      await patchJson("/api/admin/settings", {
        globalProviderModels,
      });
      setSaveStatus("success");
    } catch {
      setSaveStatus("error");
    }
    setSaving(false);
  }, [adminSettings, providerEnabled, modelEnabled]);

  const isLoading = providersLoading && modelsLoading && settingsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  const configuredProviderIds = new Set(providers.map((p) => p.provider));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GlassPanel className="rounded-xl p-2">
            <Bot className="text-muted-foreground h-4 w-4 md:h-5 md:w-5" />
          </GlassPanel>
          <div>
            <h1 className="text-lg font-semibold tracking-tight md:text-2xl">Model Providers</h1>
            <p className="text-muted-foreground text-xs md:text-sm">
              Manage global API providers and model availability
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {saveStatus === "success" && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="text-destructive flex items-center gap-1 text-xs">
              <AlertCircle className="h-3.5 w-3.5" /> Error
            </span>
          )}
          {activeTab === "models" && (
            <Button size="sm" disabled={saving} onClick={handleSaveModels}>
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Save
            </Button>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "providers" | "models")}>
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="providers" className="gap-2">
              <Key className="h-4 w-4" />
              API Providers
            </TabsTrigger>
            <TabsTrigger value="models" className="gap-2">
              <Bot className="h-4 w-4" />
              Model Availability
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ─── Providers Tab ─── */}
        <TabsContent value="providers" className="space-y-6">
          <GlassPanel>
            <GlassPanelHeader
              title="Configured Providers"
              action={
                <Button variant="secondary" size="sm" onClick={() => setShowAddProvider(true)}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add
                </Button>
              }
            />
            <GlassPanelContent className="p-0">
              {providers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Key className="text-muted-foreground/50 mb-3 h-8 w-8" />
                  <p className="text-sm font-medium">No global providers configured</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Add a provider to make its models available to all users
                  </p>
                </div>
              ) : (
                providers.map((prov, i) => (
                  <div key={prov.id}>
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{prov.displayName}</span>
                          {prov.provider === "custom" && prov.baseUrl && (
                            <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
                              custom
                            </Badge>
                          )}
                        </div>
                        <span className="text-muted-foreground truncate text-xs">
                          {prov.provider}
                          {prov.baseUrl ? ` — ${prov.baseUrl}` : ""}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive h-8 w-8"
                        onClick={() => handleRemoveProvider(prov.provider)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {i < providers.length - 1 && <Separator className="px-4" />}
                  </div>
                ))
              )}
            </GlassPanelContent>
          </GlassPanel>

          {/* Available but not configured */}
          {availableProviders.filter((p) => !configuredProviderIds.has(p.id)).length > 0 && (
            <GlassPanel>
              <GlassPanelHeader title="Available Providers" />
              <GlassPanelContent className="p-0">
                {availableProviders
                  .filter((p) => !configuredProviderIds.has(p.id))
                  .map((prov, i) => (
                    <div key={prov.id}>
                      <div className="flex items-center justify-between px-4 py-3">
                        <span className="text-muted-foreground text-sm">{prov.name}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            setAddProvider(prov.id);
                            setShowAddProvider(true);
                          }}
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" /> Add
                        </Button>
                      </div>
                      {i <
                        availableProviders.filter((p) => !configuredProviderIds.has(p.id)).length -
                          1 && <Separator className="px-4" />}
                    </div>
                  ))}
              </GlassPanelContent>
            </GlassPanel>
          )}
        </TabsContent>

        {/* ─── Models Tab ─── */}
        <TabsContent value="models" className="space-y-6">
          {modelProviders.length === 0 && (
            <GlassPanel>
              <GlassPanelContent>
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Bot className="text-muted-foreground/50 mb-3 h-8 w-8" />
                  <p className="text-sm font-medium">No models available</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    Add API providers first to discover models
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-4"
                    onClick={() => setActiveTab("providers")}
                  >
                    Go to providers
                  </Button>
                </div>
              </GlassPanelContent>
            </GlassPanel>
          )}

          {modelProviders.map((provider) => {
            const models = availableModels[provider.id] ?? [];
            const isProviderEnabled = providerEnabled[provider.id] ?? true;
            const enabledModels = modelEnabled[provider.id] ?? new Set(models.map((m) => m.id));

            return (
              <GlassPanel key={provider.id}>
                <GlassPanelHeader
                  title={provider.name}
                  action={
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary" className="rounded-full text-xs">
                        {provider.modelCount} models
                      </Badge>
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground text-xs">Enabled</span>
                        <Switch
                          checked={isProviderEnabled}
                          onCheckedChange={(checked) => handleProviderToggle(provider.id, checked)}
                        />
                      </div>
                    </div>
                  }
                />
                <GlassPanelContent className="p-0">
                  {!isProviderEnabled ? (
                    <div className="px-4 py-6 text-center">
                      <p className="text-muted-foreground text-sm">
                        Provider disabled — all models from this provider are unavailable
                      </p>
                    </div>
                  ) : models.length === 0 ? (
                    <div className="px-4 py-6 text-center">
                      <p className="text-muted-foreground text-sm">No models discovered yet</p>
                    </div>
                  ) : (
                    models.map((model, i) => {
                      const isModelEnabled = enabledModels.has(model.id);
                      return (
                        <div key={model.id}>
                          <div className="flex items-center justify-between px-4 py-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium">{model.name}</span>
                                {model.reasoning && (
                                  <Badge
                                    variant="secondary"
                                    className="rounded-full px-1.5 text-[10px]"
                                  >
                                    reasoning
                                  </Badge>
                                )}
                              </div>
                              <span className="text-muted-foreground text-xs">{model.id}</span>
                            </div>
                            <Switch
                              checked={isModelEnabled}
                              onCheckedChange={(checked) =>
                                handleModelToggle(provider.id, model.id, checked)
                              }
                              disabled={!isProviderEnabled}
                            />
                          </div>
                          {i < models.length - 1 && <Separator className="px-4" />}
                        </div>
                      );
                    })
                  )}
                </GlassPanelContent>
              </GlassPanel>
            );
          })}
        </TabsContent>
      </Tabs>

      {/* Add provider dialog */}
      <Dialog open={showAddProvider} onOpenChange={setShowAddProvider}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add provider</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={addProvider} onValueChange={(v) => setAddProvider(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
                  {availableProviders
                    .filter((p) => !configuredProviderIds.has(p.id))
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>
                API Key <span className="text-muted-foreground">(optional for local servers)</span>
              </Label>
              <Input
                value={addApiKey}
                onChange={(e) => setAddApiKey(e.target.value)}
                type="password"
                placeholder="sk-..."
              />
            </div>
            {addProvider === "custom" && (
              <div className="space-y-2">
                <Label>Base URL</Label>
                <Input
                  value={addBaseUrl}
                  onChange={(e) => setAddBaseUrl(e.target.value)}
                  placeholder="https://api.example.com/v1"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowAddProvider(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddProvider} disabled={adding || !addProvider}>
              {adding ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
