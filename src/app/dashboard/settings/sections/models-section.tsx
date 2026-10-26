"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Bot,
  CheckCircle,
  Loader2,
  Sparkles,
  Search,
  EyeOff,
  Eye,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ModelLimitsSheet,
  type ModelLimitsTarget,
} from "@/components/providers/model-limits-sheet";
import { SaveFooter } from "../components/save-footer";
import { ProviderManagement } from "../components/provider-management";
import { ModelSidebar } from "../components/model-sidebar";
import { useUserSettings } from "../components/user-settings-provider";
import { cn } from "@/lib/utils";
import { patchJson } from "@/lib/http";
import { useState, useMemo, useEffect, useCallback } from "react";
import type {
  UserSettings,
  AvailableModel,
  AvailableProvider,
  PurposeModelSelection,
} from "../types";

interface FullModelInfo extends AvailableModel {
  provider: string;
  providerName: string;
}

/** The endpoint-wide defaults a model's own limits fall back to. */
interface EndpointLimits {
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
  }
  return String(tokens);
}

function resolveEffectiveModel(
  settings: UserSettings | null,
  purposeId: string,
): PurposeModelSelection | null {
  if (!settings) return null;
  const overrides = settings.purposeModelOverrides ?? {};
  const override = overrides[purposeId];
  if (override?.provider && override?.model) return override;
  if (settings.defaultModelProvider && settings.defaultModelName) {
    return { provider: settings.defaultModelProvider, model: settings.defaultModelName };
  }
  return null;
}

/* ─── Main Tab ─── */

export function ModelsSection() {
  const {
    settings,
    updateSettings: onSettingsChange,
    saving,
    saveStatus,
    save: onSave,
  } = useUserSettings();
  const [search, setSearch] = useState("");
  const [activePurpose, setActivePurpose] = useState("__default__");
  const [allModels, setAllModels] = useState<FullModelInfo[]>([]);
  const [disabledSet, setDisabledSet] = useState<Set<string>>(new Set());
  const [availableModels, setAvailableModels] = useState<Record<string, AvailableModel[]>>({});
  const [availableModelProviders, setAvailableModelProviders] = useState<AvailableProvider[]>([]);
  /** Providers whose per-model metadata (vision) the user can set. */
  const [configurableProviders, setConfigurableProviders] = useState<Set<string>>(new Set());
  /** Model currently having its vision flag written, so it can show as busy. */
  const [savingVision, setSavingVision] = useState<string | null>(null);
  /** The model whose per-model limits are open in the sheet. */
  const [limitsTarget, setLimitsTarget] = useState<ModelLimitsTarget | null>(null);
  /** What a model without its own limits inherits from the endpoint. */
  const [endpointLimits, setEndpointLimits] = useState<EndpointLimits | null>(null);

  // Load available models (enabled only)
  const loadModels = useCallback(async () => {
    try {
      const data = await fetch("/api/providers/models").then((r) => r.json());
      setAvailableModels(data.models ?? {});
      setAvailableModelProviders(data.providers ?? []);
    } catch {
      // No models available yet
    }
  }, []);

  // Load ALL models (including disabled), with every provider's editability
  // a per-model capability is only settable where Saale defines the models.
  const loadAllModels = useCallback(async () => {
    try {
      const data: {
        models: Record<string, AvailableModel[]>;
        providers?: Array<{ id: string; name: string; modelsConfigurable?: boolean }>;
        disabledModels?: string[];
        endpointLimits?: EndpointLimits | null;
      } = await fetch("/api/providers/models?includeDisabled=true").then((r) => r.json());

      const all: FullModelInfo[] = [];
      for (const [provider, modelsList] of Object.entries(data.models ?? {})) {
        const providerName =
          (data.providers ?? []).find((p) => p.id === provider)?.name ?? provider;
        for (const m of modelsList) {
          all.push({ ...m, provider, providerName });
        }
      }
      setAllModels(all);
      setDisabledSet(new Set(data.disabledModels ?? []));
      setConfigurableProviders(
        new Set((data.providers ?? []).filter((p) => p.modelsConfigurable).map((p) => p.id)),
      );
      setEndpointLimits(data.endpointLimits ?? null);
    } catch (err) {
      console.error("Failed to load admin model settings:", err);
    }
  }, []);

  // Load ALL models (including disabled)
  useEffect(() => {
    loadAllModels();
  }, [loadAllModels]);

  // Initial load
  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // Build providers with their models
  const providersWithModels = availableModelProviders
    .map((p) => ({
      ...p,
      models: (availableModels[p.id] ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((p) => p.models.length > 0);

  // Group all models (including disabled) by provider
  const allByProvider = useMemo(() => {
    const groups: Record<string, FullModelInfo[]> = {};
    for (const m of allModels) {
      if (!groups[m.provider]) groups[m.provider] = [];
      groups[m.provider]!.push(m);
    }
    for (const key of Object.keys(groups)) {
      groups[key]!.sort((a, b) => a.name.localeCompare(b.name));
    }
    return groups;
  }, [allModels]);

  // Filter by search
  const filteredAllProviders = useMemo(() => {
    if (!search.trim()) return allByProvider;
    const q = search.toLowerCase();
    const result: Record<string, FullModelInfo[]> = {};
    for (const [provider, providerModels] of Object.entries(allByProvider)) {
      const providerName = providerModels[0]?.providerName ?? provider;
      const filtered = providerModels.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          provider.toLowerCase().includes(q) ||
          providerName.toLowerCase().includes(q),
      );
      if (filtered.length > 0) result[provider] = filtered;
    }
    return result;
  }, [allByProvider, search]);

  const isDisabled = (provider: string, modelId: string) =>
    disabledSet.has(`${provider}:${modelId}`);

  /**
   * Record whether a model can see images.
   *
   * Written straight through rather than with the settings Save: this is model
   * metadata on the provider key (like the token limits), and what the toggle
   * shows comes from the endpoint definition anyway. a pending edit would only
   * show a badge that does not match what Pi will send.
   */
  const handleToggleVision = async (provider: string, modelId: string, vision: boolean) => {
    const key = `${provider}:${modelId}`;
    setSavingVision(key);
    try {
      await patchJson("/api/providers/capabilities", { provider, modelId, vision });
      await Promise.all([loadAllModels(), loadModels()]);
    } catch (err) {
      console.error("Failed to save model vision capability:", err);
    }
    setSavingVision(null);
  };

  /** Open the per-model limit editor for one row. */
  const openLimits = (model: FullModelInfo) => {
    setLimitsTarget({
      provider: model.provider,
      providerName: model.providerName,
      modelId: model.id,
      modelName: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      overrides: model.overrides,
      endpointLimits,
    });
  };

  const handleToggleModel = (provider: string, modelId: string) => {
    if (!settings) return;
    const key = `${provider}:${modelId}`;
    const current = settings.disabledModels ?? [];
    const updated = isDisabled(provider, modelId)
      ? current.filter((k) => k !== key)
      : [...current, key];
    onSettingsChange({
      ...settings,
      disabledModels: updated.length > 0 ? updated : null,
    });
    setDisabledSet(new Set(updated));
  };

  // Effective model for active purpose
  const effectiveModel = useMemo(
    () =>
      activePurpose === "__default__"
        ? settings?.defaultModelProvider && settings?.defaultModelName
          ? { provider: settings.defaultModelProvider, model: settings.defaultModelName }
          : null
        : resolveEffectiveModel(settings, activePurpose),
    [settings, activePurpose],
  );

  const isPurposeOverride = useMemo(() => {
    if (activePurpose === "__default__") return false;
    const overrides = settings?.purposeModelOverrides ?? {};
    return !!(overrides[activePurpose]?.provider && overrides[activePurpose]?.model);
  }, [settings, activePurpose]);

  const selectedProvider = providersWithModels.find((p) => p.id === effectiveModel?.provider);

  const handleSelectModel = (providerId: string, modelId: string) => {
    if (!settings) return;
    if (activePurpose === "__default__") {
      onSettingsChange({
        ...settings,
        defaultModelProvider: providerId,
        defaultModelName: modelId,
      });
    } else {
      const overrides = settings.purposeModelOverrides ?? {};
      onSettingsChange({
        ...settings,
        purposeModelOverrides: {
          ...overrides,
          [activePurpose]: { provider: providerId, model: modelId },
        },
      });
    }
  };

  const handleResetPurpose = () => {
    if (!settings || activePurpose === "__default__") return;
    const overrides = { ...(settings.purposeModelOverrides ?? {}) };
    delete overrides[activePurpose];
    onSettingsChange({
      ...settings,
      purposeModelOverrides: Object.keys(overrides).length > 0 ? overrides : null,
    });
  };

  return (
    <GlassPanel>
      <GlassPanelContent className="p-0">
        {/* Header */}
        <div className="px-6 pt-5 pb-4">
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Bot className="h-5 w-5" />
            AI &amp; Models
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage API keys, choose models, and configure reasoning per purpose.
          </p>
        </div>

        <Separator />

        {/* API Keys section */}
        <div className="px-6 pt-4 pb-2">
          <ProviderManagement onModelsChanged={loadModels} />
        </div>

        <Separator />

        <div className="flex flex-col gap-6 lg:flex-row">
          {/* ─── Model Browser ─── */}
          <div className="min-h-0 flex-1">
            <div className="flex flex-col">
              <div className="px-6 py-3">
                <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Models
                </Label>
              </div>

              {/* Search */}
              <div className="px-4 pb-2">
                <div className="relative">
                  <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                  <Input
                    type="text"
                    placeholder="Search models…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-9 text-sm"
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1">
                <ScrollArea className="h-full">
                  <div className="px-3 pb-3">
                    {allModels.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center">
                        <Sparkles className="text-muted-foreground/50 mb-3 h-8 w-8" />
                        <p className="text-sm font-medium">No models available</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          Add an API key above to get started.
                        </p>
                      </div>
                    ) : Object.keys(filteredAllProviders).length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center">
                        <Search className="text-muted-foreground/50 mb-3 h-8 w-8" />
                        <p className="text-sm font-medium">No models match</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          Try a different keyword
                        </p>
                      </div>
                    ) : (
                      Object.entries(filteredAllProviders).map(([providerKey, providerModels]) => {
                        const enabledCount = providerModels.filter(
                          (m) => !isDisabled(providerKey, m.id),
                        ).length;
                        const allEnabled =
                          providerModels.length > 0 && enabledCount === providerModels.length;

                        return (
                          <div key={providerKey} className="mb-1">
                            <div className="flex items-center justify-between px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground text-xs font-medium">
                                  {providerModels[0]?.providerName ?? providerKey}
                                </span>
                                <span className="text-muted-foreground/60 text-[10px]">
                                  {enabledCount}/{providerModels.length}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-muted-foreground text-[10px]">All</span>
                                <Switch
                                  checked={allEnabled}
                                  onCheckedChange={(checked) => {
                                    if (!settings) return;
                                    const current = settings.disabledModels ?? [];
                                    const providerModelKeys = providerModels.map(
                                      (m) => `${providerKey}:${m.id}`,
                                    );
                                    let updated: string[];
                                    if (checked) {
                                      // Enable all: remove this provider's models from disabled list
                                      updated = current.filter(
                                        (k) => !providerModelKeys.includes(k),
                                      );
                                    } else {
                                      // Disable all: add all provider models to disabled list
                                      updated = [...new Set([...current, ...providerModelKeys])];
                                    }
                                    onSettingsChange({
                                      ...settings,
                                      disabledModels: updated.length > 0 ? updated : null,
                                    });
                                    setDisabledSet(new Set(updated));
                                  }}
                                  className="scale-75 data-unchecked:opacity-50"
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            </div>

                            {providerModels.map((model) => {
                              const isSelected =
                                effectiveModel?.provider === providerKey &&
                                effectiveModel?.model === model.id;
                              const disabled = isDisabled(providerKey, model.id);

                              return (
                                <div
                                  key={model.id}
                                  className={cn(
                                    "group flex items-center gap-3 rounded-xl px-3 py-2 transition-colors",
                                    !disabled && "hover:bg-accent/60 cursor-pointer",
                                    disabled && "opacity-50",
                                    isSelected && !disabled && "bg-primary/10",
                                  )}
                                  onClick={() => {
                                    if (!disabled) handleSelectModel(providerKey, model.id);
                                  }}
                                >
                                  <div
                                    className={cn(
                                      "h-2 w-2 shrink-0 rounded-full transition-colors",
                                      isSelected && !disabled
                                        ? "bg-primary"
                                        : "bg-muted-foreground/30",
                                    )}
                                  />

                                  <div className="min-w-0 flex-1 text-left">
                                    <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2 sm:gap-y-1">
                                      <span
                                        className={cn(
                                          "truncate text-sm",
                                          isSelected ? "font-medium" : "font-normal",
                                          disabled && "line-through",
                                        )}
                                      >
                                        {model.name}
                                      </span>
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <Badge
                                          variant="outline"
                                          className="shrink-0 rounded-full px-1.5 text-[10px] font-normal"
                                        >
                                          {model.providerName}
                                        </Badge>
                                        {model.reasoning && (
                                          <Badge
                                            variant="secondary"
                                            className="shrink-0 rounded-full"
                                          >
                                            <Sparkles className="mr-0.5 h-3 w-3" />
                                            Reasoning
                                          </Badge>
                                        )}
                                        {/* Where Saale defines the models, the badge is
                                            the control: clicking it records vision. */}
                                        {model.vision &&
                                          (configurableProviders.has(providerKey) ? (
                                            <Button
                                              type="button"
                                              variant="outline"
                                              size="xs"
                                              className="h-5 shrink-0 gap-1 rounded-full px-1.5 text-[10px] font-normal text-emerald-600 dark:text-emerald-400"
                                              title="Toggle image support for this model"
                                              disabled={
                                                savingVision === `${providerKey}:${model.id}`
                                              }
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                handleToggleVision(providerKey, model.id, false);
                                              }}
                                            >
                                              {savingVision === `${providerKey}:${model.id}` ? (
                                                <Loader2 className="h-3 w-3 animate-spin" />
                                              ) : (
                                                <Eye className="h-3 w-3" />
                                              )}
                                              Vision
                                            </Button>
                                          ) : (
                                            <Badge
                                              variant="outline"
                                              className="shrink-0 rounded-full px-1.5 text-[10px] font-normal"
                                            >
                                              <Eye className="mr-0.5 h-3 w-3" />
                                              Vision
                                            </Badge>
                                          ))}
                                        {disabled && (
                                          <EyeOff className="text-muted-foreground h-3 w-3 shrink-0" />
                                        )}
                                      </div>
                                    </div>
                                    {model.contextWindow && model.contextWindow > 0 && (
                                      <span className="text-muted-foreground text-xs">
                                        {formatContextWindow(model.contextWindow)} context
                                        {model.maxOutputTokens
                                          ? ` · ${formatContextWindow(model.maxOutputTokens)} out`
                                          : ""}
                                        {model.overrides ? " · set here" : ""}
                                      </span>
                                    )}
                                  </div>

                                  <div className="flex shrink-0 items-center gap-1">
                                    {isSelected && !disabled && (
                                      <CheckCircle className="text-primary h-4 w-4 shrink-0" />
                                    )}

                                    {/* One endpoint can serve models with different
                                        windows, so the limits are per model. */}
                                    {configurableProviders.has(providerKey) && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        className="text-muted-foreground/60 shrink-0"
                                        title="Set this model's context window and output cap"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openLimits(model);
                                        }}
                                      >
                                        <SlidersHorizontal className="h-3.5 w-3.5" />
                                      </Button>
                                    )}

                                    {/* A text-only model can be told to take images
                                        where the endpoint is silent about it. */}
                                    {!model.vision && configurableProviders.has(providerKey) && (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        className="text-muted-foreground/60 shrink-0 hover:text-emerald-600 dark:hover:text-emerald-400"
                                        title="Mark this model as able to see images"
                                        disabled={savingVision === `${providerKey}:${model.id}`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleToggleVision(providerKey, model.id, true);
                                        }}
                                      >
                                        <Eye className="h-3.5 w-3.5" />
                                      </Button>
                                    )}

                                    <Switch
                                      checked={!disabled}
                                      onCheckedChange={() =>
                                        handleToggleModel(providerKey, model.id)
                                      }
                                      className="scale-75 data-unchecked:opacity-50"
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          </div>

          {/* ─── Right Sidebar ─── */}
          <ModelSidebar
            settings={settings}
            activePurpose={activePurpose}
            onPurposeChange={setActivePurpose}
            effectiveModel={effectiveModel}
            selectedProvider={selectedProvider}
            isPurposeOverride={isPurposeOverride}
            onResetPurpose={handleResetPurpose}
            onSettingsChange={onSettingsChange}
          />
        </div>
      </GlassPanelContent>

      <ModelLimitsSheet
        target={limitsTarget}
        onOpenChange={(open) => {
          if (!open) setLimitsTarget(null);
        }}
        capabilitiesEndpoint="/api/providers/capabilities"
        onSaved={() => {
          void loadAllModels();
          void loadModels();
        }}
      />

      <SaveFooter saving={saving} saveStatus={saveStatus} onSave={onSave} />
    </GlassPanel>
  );
}
