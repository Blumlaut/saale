"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Page, PageScroll } from "@/components/layout/page";
import {
  fromGlobalProviderModels,
  toGlobalProviderModels,
  type ProviderModelConfig,
} from "@/lib/admin/model-availability";
import { fetchJson, patchJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import {
  Bot,
  Loader2,
  CheckCircle,
  AlertCircle,
  Search,
  Eye,
  SlidersHorizontal,
} from "lucide-react";
import {
  ModelLimitsSheet,
  type ModelLimitsTarget,
} from "@/components/providers/model-limits-sheet";
import type { AvailableModel, AvailableProvider } from "@/app/dashboard/settings/types";

interface AdminSettings {
  signupsEnabled: boolean;
  globalModelProvider: string;
  globalModelName: string;
  globalProviderModels: Record<string, ProviderModelConfig> | null;
}

/** Which models the instance offers, and where each provider's limits sit. */
export function ModelAvailability() {
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
  const [savingVision, setSavingVision] = useState<string | null>(null);

  // ─── Per-model limits ───
  const [limitsTarget, setLimitsTarget] = useState<ModelLimitsTarget | null>(null);
  const [endpointLimits, setEndpointLimits] = useState<{
    contextWindow: number | null;
    maxOutputTokens: number | null;
  } | null>(null);

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

  // ─── Load models (global providers only) ───
  const loadModels = useCallback(async () => {
    try {
      const data = await fetchJson<{
        models: Record<string, AvailableModel[]>;
        providers: AvailableProvider[];
        endpointLimits?: {
          contextWindow: number | null;
          maxOutputTokens: number | null;
        } | null;
      }>("/api/admin/providers/models");
      setAvailableModels(data.models ?? {});
      setModelProviders(data.providers ?? []);
      setEndpointLimits(data.endpointLimits ?? null);
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

      setModelEnabled(fromGlobalProviderModels(data.settings.globalProviderModels));
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([loadModels(), loadSettings()]).catch((err) => {
      console.error("Failed to load admin model data:", err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Provider actions ───

  /** Whether a provider's per-model metadata is Saale's to record. */
  const canConfigureModels = (provider: string) =>
    modelProviders.find((p) => p.id === provider)?.modelsConfigurable === true;

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

  /** Open the per-model limit editor for one row. */
  const openLimits = (providerId: string, providerName: string, model: AvailableModel) => {
    setLimitsTarget({
      provider: providerId,
      providerName,
      modelId: model.id,
      modelName: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      overrides: model.overrides,
      endpointLimits,
    });
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

    const globalProviderModels = toGlobalProviderModels(Object.keys(availableModels), modelEnabled);

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

  const isLoading = modelsLoading && settingsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          {/* Toolbar. search left, save right */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                type="text"
                placeholder="Search models…"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                className="h-8 pl-9 text-sm"
              />
            </div>

            <div className="ml-auto flex items-center gap-2">
              {capabilityInfo && (
                <span className="text-muted-foreground hidden items-center gap-1 text-xs sm:flex">
                  <Bot className="h-3.5 w-3.5" /> {capabilityInfo}
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
              <Button size="sm" disabled={saving} onClick={handleSaveModels}>
                {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>

          <PageScroll className="space-y-6 p-4">
            {modelProviders.length === 0 && (
              <GlassPanel>
                <GlassPanelContent>
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Bot className="text-muted-foreground/50 mb-3 h-8 w-8" />
                    <p className="text-sm font-medium">No models available</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Add API providers first to discover models
                    </p>
                    <Button variant="secondary" size="sm" className="mt-4" asChild>
                      <Link href="/admin/models/providers">Go to providers</Link>
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
                              <span className="text-muted-foreground text-xs">
                                {model.id}
                                {model.contextWindow
                                  ? ` · ${model.contextWindow.toLocaleString()} context`
                                  : ""}
                                {model.overrides ? " · set here" : ""}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {/* One endpoint can serve models with different
                        windows, so the limits are per model. */}
                              {canConfigureModels(provider.id) && (
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  className="text-muted-foreground/60 shrink-0"
                                  title="Set this model's context window and output cap"
                                  onClick={() => openLimits(provider.id, provider.name, model)}
                                >
                                  <SlidersHorizontal className="h-3.5 w-3.5" />
                                </Button>
                              )}

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
                                      ? "Can see images. click to turn that off"
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
          </PageScroll>
        </GlassPanel>
      </div>

      <ModelLimitsSheet
        target={limitsTarget}
        onOpenChange={(open) => {
          if (!open) setLimitsTarget(null);
        }}
        capabilitiesEndpoint="/api/admin/providers/capabilities"
        onSaved={() => {
          void loadModels();
        }}
      />
    </Page>
  );
}
