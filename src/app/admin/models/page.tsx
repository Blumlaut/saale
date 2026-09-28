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
import { cn } from "@/lib/utils";
import {
  Bot,
  Key,
  Loader2,
  CheckCircle,
  AlertCircle,
  Plus,
  Trash2,
  Search,
  Eye,
  ScanEye,
} from "lucide-react";
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
  const [availableProviders, setAvailableProviders] = useState<
    { id: string; name: string; modelsConfigurable?: boolean }[]
  >([]);
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
  const [modelSearch, setModelSearch] = useState("");

  // Per-model toggle state (Set of enabled model IDs per provider)
  const [modelEnabled, setModelEnabled] = useState<Record<string, Set<string>>>({});

  // ─── Save status ───
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // ─── Capability (vision) status ───
  const [capabilityInfo, setCapabilityInfo] = useState<string | null>(null);
  const [detecting, setDetecting] = useState<string | null>(null);
  const [savingVision, setSavingVision] = useState<string | null>(null);

  // Auto-clear save status
  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  // Auto-clear capability status
  useEffect(() => {
    if (capabilityInfo) {
      const timer = setTimeout(() => setCapabilityInfo(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [capabilityInfo]);

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

  // ─── Load models (global providers only) ───
  const loadModels = useCallback(async () => {
    try {
      const data = await fetchJson<{
        models: Record<string, AvailableModel[]>;
        providers: AvailableProvider[];
      }>("/api/admin/providers/models");
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
      const models: Record<string, Set<string>> = {};

      for (const [providerId, config] of Object.entries(providerModels)) {
        if ((config as ProviderModelConfig).models) {
          models[providerId] = new Set((config as ProviderModelConfig).models);
        }
      }

      setModelEnabled(models);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadProviders(), loadModels(), loadSettings()]).catch((err) => {
      console.error("Failed to load admin model data:", err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Provider actions ───

  /** Whether a configured provider's per-model metadata is Saale's to record. */
  const canConfigureModels = (provider: string) =>
    availableProviders.find((p) => p.id === provider)?.modelsConfigurable === true;

  /**
   * Ask a global provider's endpoint what its models can do and store it.
   *
   * Same button as in the user's own settings: only llama.cpp's `/props`
   * answers, so "no answer" has to be visible rather than read as "no vision".
   */
  const handleDetectCapabilities = async (provider: string) => {
    setDetecting(provider);
    try {
      const data = await postJson<{
        modelCount: number;
        detected: number;
        visionModels: number;
        unprobed: number;
      }>("/api/admin/providers/capabilities", { provider });
      setCapabilityInfo(
        data.detected === 0
          ? "This endpoint reports no model capabilities — set vision per model instead"
          : `${data.visionModels} of ${data.modelCount} models accept images` +
              (data.unprobed > 0 ? ` (${data.unprobed} did not report)` : ""),
      );
      await loadModels();
    } catch (err) {
      console.error("Failed to detect global provider capabilities:", err);
      setCapabilityInfo("Capability detection failed");
    }
    setDetecting(null);
  };

  /** Record whether a global provider's model can see images. */
  const handleToggleVision = async (provider: string, modelId: string, vision: boolean) => {
    const key = `${provider}:${modelId}`;
    setSavingVision(key);
    try {
      await patchJson("/api/admin/providers/capabilities", { provider, modelId, vision });
      await loadModels();
    } catch (err) {
      console.error("Failed to save model vision capability:", err);
      setCapabilityInfo("Could not save the model capability");
    }
    setSavingVision(null);
  };

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
    setModelEnabled((prev) => {
      const models = availableModels[providerId] ?? [];
      if (enabled) {
        // Enable all models
        return { ...prev, [providerId]: new Set(models.map((m) => m.id)) };
      } else {
        // Disable all models
        return { ...prev, [providerId]: new Set() };
      }
    });
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
    for (const providerId of Object.keys(availableModels)) {
      globalProviderModels[providerId] = {
        enabled: true,
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
  }, [adminSettings, availableModels, modelEnabled]);

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
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
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
            {capabilityInfo && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <ScanEye className="h-3.5 w-3.5" /> {capabilityInfo}
              </span>
            )}
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
          <div className="no-scrollbar overflow-x-auto pb-1">
            <TabsList>
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
                              <Badge
                                variant="secondary"
                                className="rounded-full px-1.5 text-[10px]"
                              >
                                custom
                              </Badge>
                            )}
                            {canConfigureModels(prov.provider) && (
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                className="text-muted-foreground hover:text-foreground"
                                title="Detect model capabilities (vision)"
                                disabled={detecting === prov.provider}
                                onClick={() => handleDetectCapabilities(prov.provider)}
                              >
                                {detecting === prov.provider ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <ScanEye className="h-3.5 w-3.5" />
                                )}
                              </Button>
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
                          availableProviders.filter((p) => !configuredProviderIds.has(p.id))
                            .length -
                            1 && <Separator className="px-4" />}
                      </div>
                    ))}
                </GlassPanelContent>
              </GlassPanel>
            )}
          </TabsContent>

          {/* ─── Models Tab ─── */}
          <TabsContent value="models" className="space-y-6">
            {/* Search */}
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                type="text"
                placeholder="Search models…"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                className="h-8 pl-9 text-sm"
              />
            </div>

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

            {modelSearch.trim() &&
              modelProviders.every((p) => {
                const models = availableModels[p.id] ?? [];
                const q = modelSearch.toLowerCase();
                return models.every(
                  (m) =>
                    !m.name.toLowerCase().includes(q) &&
                    !m.id.toLowerCase().includes(q) &&
                    !p.name.toLowerCase().includes(q),
                );
              }) && (
                <GlassPanel>
                  <GlassPanelContent>
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Search className="text-muted-foreground/50 mb-3 h-8 w-8" />
                      <p className="text-sm font-medium">No models match</p>
                      <p className="text-muted-foreground mt-1 text-xs">Try a different keyword</p>
                    </div>
                  </GlassPanelContent>
                </GlassPanel>
              )}

            {modelProviders.map((provider) => {
              let models = availableModels[provider.id] ?? [];
              const q = modelSearch.trim().toLowerCase();
              if (q) {
                models = models.filter(
                  (m) =>
                    m.name.toLowerCase().includes(q) ||
                    m.id.toLowerCase().includes(q) ||
                    provider.name.toLowerCase().includes(q),
                );
              }
              const enabledModels =
                modelEnabled[provider.id] ??
                new Set((availableModels[provider.id] ?? []).map((m) => m.id));
              const allEnabled = models.length > 0 && models.every((m) => enabledModels.has(m.id));

              if (models.length === 0) return null;

              return (
                <GlassPanel key={provider.id}>
                  <GlassPanelHeader
                    title={provider.name}
                    action={
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary" className="rounded-full text-xs">
                          {enabledModels.size}/{(availableModels[provider.id] ?? []).length} enabled
                        </Badge>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">All</span>
                          <Switch
                            checked={allEnabled}
                            onCheckedChange={(checked) =>
                              handleProviderToggle(provider.id, checked)
                            }
                          />
                        </div>
                      </div>
                    }
                  />
                  <GlassPanelContent className="p-0">
                    {models.map((model, i) => {
                      const isModelEnabled = enabledModels.has(model.id);
                      return (
                        <div key={model.id}>
                          <div className="flex items-center justify-between px-4 py-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium">{model.name}</span>
                                <Badge
                                  variant="outline"
                                  className="shrink-0 rounded-full px-1.5 text-[10px] font-normal"
                                >
                                  {provider.name}
                                </Badge>
                                {model.reasoning && (
                                  <Badge
                                    variant="secondary"
                                    className="rounded-full px-1.5 text-[10px]"
                                  >
                                    reasoning
                                  </Badge>
                                )}
                                {model.vision && (
                                  <Badge
                                    variant="outline"
                                    className="shrink-0 gap-1 rounded-full px-1.5 text-[10px] font-normal text-emerald-600 dark:text-emerald-400"
                                  >
                                    <Eye className="h-3 w-3" />
                                    vision
                                  </Badge>
                                )}
                              </div>
                              <span className="text-muted-foreground text-xs">{model.id}</span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {/* Undo a wrong (or absent) answer from the endpoint. */}
                              {canConfigureModels(provider.id) && (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className={cn(
                                    "shrink-0",
                                    model.vision
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-muted-foreground/60 hover:text-foreground",
                                  )}
                                  title={
                                    model.vision
                                      ? "Can see images — click to turn that off"
                                      : "Mark this model as able to see images"
                                  }
                                  disabled={savingVision === `${provider.id}:${model.id}`}
                                  onClick={() =>
                                    handleToggleVision(provider.id, model.id, !model.vision)
                                  }
                                >
                                  {savingVision === `${provider.id}:${model.id}` ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Eye className="h-3.5 w-3.5" />
                                  )}
                                </Button>
                              )}
                              <Switch
                                checked={isModelEnabled}
                                onCheckedChange={(checked) =>
                                  handleModelToggle(provider.id, model.id, checked)
                                }
                              />
                            </div>
                          </div>
                          {i < models.length - 1 && <Separator className="px-4" />}
                        </div>
                      );
                    })}
                  </GlassPanelContent>
                </GlassPanel>
              );
            })}
          </TabsContent>
        </Tabs>
      </div>

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
