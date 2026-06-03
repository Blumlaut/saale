"use client";

import { GlassPanel, GlassPanelContent, GlassPanelFooter } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Bot,
  Loader2,
  CheckCircle,
  AlertCircle,
  Sparkles,
  Brain,
  Zap,
  Search,
  RotateCcw,
  Globe,
  EyeOff,
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff as EyeOffIcon,
  Shield,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useMemo, useEffect, useCallback } from "react";
import { getAllPurposes } from "@/lib/pi/purposes";
import { postJson, deleteJson } from "@/lib/http";
import type {
  UserSettings,
  ConfiguredProvider,
  ProviderInfo,
  AvailableModel,
  AvailableProvider,
  PurposeModelSelection,
} from "../types";

interface AiModelsTabProps {
  settings: UserSettings | null;
  onSettingsChange: (settings: UserSettings) => void;
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  onSave: () => Promise<void>;
}

interface FullModelInfo extends AvailableModel {
  provider: string;
  providerName: string;
}

const thinkingLevels = [
  { id: "off", label: "Off", description: "Fastest", icon: Zap },
  { id: "minimal", label: "Minimal", description: "Light reasoning", icon: Brain },
  { id: "low", label: "Low", description: "Basic reasoning", icon: Brain },
  { id: "medium", label: "Medium", description: "Balanced depth", icon: Brain },
  { id: "high", label: "High", description: "Deep reasoning", icon: Brain },
  { id: "xhigh", label: "X-High", description: "Maximum depth", icon: Brain },
];

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

/* ─── Provider Management Section ─── */

function ProviderManagement({ onModelsChanged }: { onModelsChanged: () => void }) {
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [globalProviders, setGlobalProviders] = useState<ConfiguredProvider[]>([]);
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [newProvider, setNewProvider] = useState("");
  const [providerOpen, setProviderOpen] = useState(false);
  const [newApiKey, setNewApiKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [discoveryInfo, setDiscoveryInfo] = useState<{ count: number; error?: string } | null>(
    null,
  );

  const loadAll = useCallback(async () => {
    try {
      const providersRes = await fetch("/api/providers").then((r) => r.json());
      setProviders(providersRes.providers ?? []);
      setGlobalProviders(providersRes.globalProviders ?? []);
      setAvailableProviders(providersRes.availableProviders ?? []);
      onModelsChanged();
    } finally {
      setLoading(false);
    }
  }, [onModelsChanged]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (status !== "idle") {
      const t = setTimeout(() => setStatus("idle"), 3000);
      return () => clearTimeout(t);
    }
  }, [status]);

  useEffect(() => {
    if (discoveryInfo) {
      const t = setTimeout(() => setDiscoveryInfo(null), 8000);
      return () => clearTimeout(t);
    }
  }, [discoveryInfo]);

  const handleAdd = async () => {
    if (!newProvider) return;
    if (newProvider === "custom" && !newBaseUrl) return;
    setAdding(true);
    try {
      const data = await postJson<{ modelCount?: number; modelError?: string }>("/api/providers", {
        provider: newProvider,
        apiKey: newApiKey,
        label: newLabel,
        baseUrl: newProvider === "custom" ? newBaseUrl : undefined,
      });
      setStatus("success");
      setNewApiKey("");
      setNewLabel("");
      setNewBaseUrl("");
      setNewProvider("");
      if (data.modelCount !== undefined) {
        const info: { count: number; error?: string } = { count: data.modelCount };
        if (data.modelError) info.error = data.modelError;
        setDiscoveryInfo(info);
      }
      await loadAll();
    } catch {
      setStatus("error");
    }
    setAdding(false);
  };

  const handleRemove = async (provider: string) => {
    try {
      await deleteJson(`/api/providers?provider=${encodeURIComponent(provider)}`);
      await loadAll();
    } catch {
      // silently fail
    }
  };

  const totalProviders = providers.length + globalProviders.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Key className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">API Keys</span>
        {totalProviders > 0 && (
          <Badge variant="secondary" className="rounded-full">
            {totalProviders}
          </Badge>
        )}
      </div>

      <div className="space-y-4">
        {/* Add form */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[160px] flex-1 space-y-1.5">
            <Label className="text-xs">Provider</Label>
            <Popover open={providerOpen} onOpenChange={setProviderOpen}>
              <PopoverTrigger className="border-border/50 focus-visible:ring-ring/50 inline-flex h-8 w-full items-center justify-between gap-2 rounded-lg border bg-transparent px-2.5 text-sm outline-hidden transition-colors hover:bg-white/10 focus-visible:ring-3 dark:hover:bg-white/5">
                <span className="truncate text-sm">
                  {availableProviders.find((p) => p.id === newProvider)?.name ?? (
                    <span className="text-muted-foreground">Select…</span>
                  )}
                </span>
                <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              </PopoverTrigger>
              <PopoverContent className="w-[200px] p-1" align="start">
                {availableProviders.map((p) => (
                  <button
                    key={p.id}
                    className={cn(
                      "flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      p.id === newProvider
                        ? "bg-primary/10 font-medium"
                        : "hover:bg-white/10 dark:hover:bg-white/5",
                    )}
                    onClick={() => {
                      setNewProvider(p.id);
                      setProviderOpen(false);
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>

          <div className="min-w-[180px] flex-1 space-y-1.5">
            <Label className="text-xs">API Key</Label>
            <div className="relative">
              <Input
                type={showApiKey ? "text" : "password"}
                placeholder="sk-…"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                className="h-8 pr-8 font-mono text-xs"
              />
              <button
                type="button"
                className="text-muted-foreground absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2"
                onClick={() => setShowApiKey((v) => !v)}
              >
                {showApiKey ? (
                  <EyeOffIcon className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          {newProvider === "custom" && (
            <div className="min-w-[200px] flex-1 space-y-1.5">
              <Label className="text-xs">Base URL</Label>
              <Input
                placeholder="http://localhost:11434/v1"
                value={newBaseUrl}
                onChange={(e) => setNewBaseUrl(e.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>
          )}

          <div className="min-w-[120px] space-y-1.5">
            <Label className="text-xs">Label</Label>
            <Input
              placeholder="optional"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          <Button
            size="sm"
            className="h-8"
            onClick={handleAdd}
            disabled={adding || !newProvider || (newProvider === "custom" && !newBaseUrl)}
          >
            {adding ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 h-3.5 w-3.5" />
            )}
            Add
          </Button>
        </div>

        {/* Status messages */}
        <div className="flex items-center gap-3">
          {status === "success" && (
            <span className="flex items-center gap-1 text-xs text-emerald-500">
              <CheckCircle className="h-3.5 w-3.5" /> Added
            </span>
          )}
          {status === "error" && (
            <span className="flex items-center gap-1 text-xs text-red-500">
              <AlertCircle className="h-3.5 w-3.5" /> Failed
            </span>
          )}
          {discoveryInfo && discoveryInfo.count > 0 && (
            <span className="flex items-center gap-1 text-xs text-blue-500">
              <Sparkles className="h-3.5 w-3.5" />
              {discoveryInfo.count} models discovered
            </span>
          )}
          {discoveryInfo && discoveryInfo.error && (
            <span className="flex items-center gap-1 text-xs text-amber-500">
              <AlertCircle className="h-3.5 w-3.5" /> {discoveryInfo.error}
            </span>
          )}
        </div>

        {/* Configured providers */}
        {(globalProviders.length > 0 || providers.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {globalProviders.map((p) => (
              <div
                key={"global-" + p.provider}
                className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/5 px-2.5 py-1"
              >
                <Shield className="h-3 w-3 text-blue-500" />
                <span className="text-xs text-blue-600 dark:text-blue-400">{p.displayName}</span>
                <span className="text-[10px] text-blue-400/60">global</span>
              </div>
            ))}
            {providers.map((p) => (
              <div
                key={p.provider}
                className="flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-1"
              >
                <Key className="h-3 w-3 text-emerald-500" />
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  {p.displayName}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-red-500"
                  onClick={() => handleRemove(p.provider)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {loading && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
      </div>
    </div>
  );
}

/* ─── Main Tab ─── */

export function AiModelsTab({
  settings,
  onSettingsChange,
  saving,
  saveStatus,
  onSave,
}: AiModelsTabProps) {
  const [search, setSearch] = useState("");
  const [activePurpose, setActivePurpose] = useState("__default__");
  const [allModels, setAllModels] = useState<FullModelInfo[]>([]);
  const [disabledSet, setDisabledSet] = useState<Set<string>>(new Set());
  const [availableModels, setAvailableModels] = useState<Record<string, AvailableModel[]>>({});
  const [availableModelProviders, setAvailableModelProviders] = useState<AvailableProvider[]>([]);

  const purposes = useMemo(() => getAllPurposes(), []);

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

  // Load ALL models (including disabled)
  useEffect(() => {
    fetch("/api/providers/models?includeDisabled=true")
      .then((r) => r.json())
      .then(
        (data: {
          models: Record<string, AvailableModel[]>;
          providers?: Array<{ id: string; name: string }>;
          disabledModels?: string[];
        }) => {
          const all: FullModelInfo[] = [];
          if (data.models) {
            for (const [provider, modelsList] of Object.entries(data.models)) {
              const providerName =
                (data.providers ?? []).find((p) => p.id === provider)?.name ?? provider;
              for (const m of modelsList) {
                all.push({ ...m, provider, providerName });
              }
            }
          }
          setAllModels(all);
          setDisabledSet(new Set(data.disabledModels ?? []));
        },
      )
      .catch(() => {});
  }, []);

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
          <div className="flex-1">
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

            <ScrollArea className="h-[300px] lg:h-[400px]">
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
                    <p className="text-muted-foreground mt-1 text-xs">Try a different keyword</p>
                  </div>
                ) : (
                  Object.entries(filteredAllProviders).map(([providerKey, providerModels]) => (
                    <div key={providerKey} className="mb-1">
                      <div className="px-3 py-2">
                        <span className="text-muted-foreground text-xs font-medium">
                          {providerModels[0]?.providerName ?? providerKey}
                        </span>
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
                              !disabled && "cursor-pointer hover:bg-white/20 dark:hover:bg-white/5",
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
                                isSelected && !disabled ? "bg-primary" : "bg-muted-foreground/30",
                              )}
                            />

                            <div className="min-w-0 flex-1 text-left">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "truncate text-sm",
                                    isSelected ? "font-medium" : "font-normal",
                                    disabled && "line-through",
                                  )}
                                >
                                  {model.name}
                                </span>
                                {model.reasoning && (
                                  <Badge variant="secondary" className="shrink-0 rounded-full">
                                    <Sparkles className="mr-0.5 h-3 w-3" />
                                    Reasoning
                                  </Badge>
                                )}
                                {disabled && (
                                  <EyeOff className="text-muted-foreground h-3 w-3 shrink-0" />
                                )}
                              </div>
                              {model.contextWindow && model.contextWindow > 0 && (
                                <span className="text-muted-foreground text-xs">
                                  {formatContextWindow(model.contextWindow)} context
                                </span>
                              )}
                            </div>

                            {isSelected && !disabled && (
                              <CheckCircle className="text-primary h-4 w-4 shrink-0" />
                            )}

                            <Switch
                              checked={!disabled}
                              onCheckedChange={() => handleToggleModel(providerKey, model.id)}
                              className="scale-75 data-[state=unchecked]:opacity-50"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* ─── Right Sidebar ─── */}
          <div className="w-full lg:w-[260px]">
            <div className="sticky top-6 space-y-5">
              {/* Purpose selector */}
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Purpose
                </Label>

                <div className="border-border/50 bg-background/40 space-y-0.5 rounded-2xl border p-1">
                  <Button
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-2.5 rounded-xl px-3 py-2 text-sm",
                      activePurpose === "__default__"
                        ? "bg-primary/10 text-foreground"
                        : "hover:bg-white/20 dark:hover:bg-white/5",
                    )}
                    onClick={() => setActivePurpose("__default__")}
                  >
                    <div
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                        activePurpose === "__default__"
                          ? "bg-primary/15 text-primary"
                          : "bg-muted/50 text-muted-foreground",
                      )}
                    >
                      <Globe className="h-3 w-3" />
                    </div>
                    <div className="flex-1 text-left">
                      <p
                        className={cn(
                          "text-sm leading-none",
                          activePurpose === "__default__" && "font-medium",
                        )}
                      >
                        Default
                      </p>
                    </div>
                    {activePurpose === "__default__" && (
                      <CheckCircle className="text-primary h-3.5 w-3.5" />
                    )}
                  </Button>

                  {purposes.map((purpose) => {
                    const isActive = activePurpose === purpose.id;
                    const PurposeIcon = purpose.icon;
                    const hasOverride = !!(settings?.purposeModelOverrides ?? {})[purpose.id]
                      ?.provider;

                    return (
                      <div key={purpose.id}>
                        <Separator className="mx-2" />
                        <Button
                          variant="ghost"
                          className={cn(
                            "w-full justify-start gap-2.5 rounded-xl px-3 py-2 text-sm",
                            isActive
                              ? "bg-primary/10 text-foreground"
                              : "hover:bg-white/20 dark:hover:bg-white/5",
                          )}
                          onClick={() => setActivePurpose(purpose.id)}
                        >
                          <div
                            className={cn(
                              "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                              isActive
                                ? "bg-primary/15 text-primary"
                                : "bg-muted/50 text-muted-foreground",
                            )}
                          >
                            <PurposeIcon className="h-3 w-3" />
                          </div>
                          <div className="flex-1 text-left">
                            <p className={cn("text-sm leading-none", isActive && "font-medium")}>
                              {purpose.label}
                            </p>
                            <p className="text-muted-foreground mt-0.5 text-[11px]">
                              {hasOverride ? "Custom" : "Using default"}
                            </p>
                          </div>
                          {isActive && <CheckCircle className="text-primary h-3.5 w-3.5" />}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Selected model */}
              {effectiveModel && selectedProvider && (
                <div className="border-border/50 bg-background/40 rounded-2xl border p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-muted-foreground text-[11px]">
                      {activePurpose === "__default__"
                        ? "Default model"
                        : (() => {
                            const p = purposes.find((pr) => pr.id === activePurpose);
                            return p ? `${p.label} model` : "Model";
                          })()}
                    </p>
                    {isPurposeOverride && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground h-5 gap-1 px-1.5 text-[10px]"
                        onClick={handleResetPurpose}
                      >
                        <RotateCcw className="h-3 w-3" />
                        Reset
                      </Button>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm font-medium">{effectiveModel.model}</p>
                  <p className="text-muted-foreground text-xs">{selectedProvider.name}</p>
                </div>
              )}

              {/* Thinking level */}
              {activePurpose === "__default__" && (
                <div className="space-y-2">
                  <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Thinking
                  </Label>

                  <div className="border-border/50 bg-background/40 space-y-0.5 rounded-2xl border p-1">
                    {thinkingLevels.map((level, index) => {
                      const isActive = settings?.defaultThinkingLevel === level.id;
                      const Icon = level.icon;

                      return (
                        <div key={level.id}>
                          {index > 0 && <Separator className="mx-2" />}
                          <Button
                            variant="ghost"
                            className={cn(
                              "w-full justify-start gap-2.5 rounded-xl px-3 py-2 text-sm",
                              isActive
                                ? "bg-primary/10 text-foreground"
                                : "hover:bg-white/20 dark:hover:bg-white/5",
                            )}
                            onClick={() => {
                              if (settings) {
                                onSettingsChange({
                                  ...settings,
                                  defaultThinkingLevel: level.id,
                                });
                              }
                            }}
                          >
                            <div
                              className={cn(
                                "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                                isActive
                                  ? "bg-primary/15 text-primary"
                                  : "bg-muted/50 text-muted-foreground",
                              )}
                            >
                              <Icon className="h-3 w-3" />
                            </div>
                            <div className="flex-1 text-left">
                              <p className={cn("text-sm leading-none", isActive && "font-medium")}>
                                {level.label}
                              </p>
                              <p className="text-muted-foreground mt-0.5 text-[11px]">
                                {level.description}
                              </p>
                            </div>
                            {isActive && <CheckCircle className="text-primary h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </GlassPanelContent>

      {/* Footer */}
      <GlassPanelFooter>
        <div>
          {saveStatus === "success" && (
            <span className="flex items-center gap-1 text-sm text-emerald-500">
              <CheckCircle className="h-4 w-4" /> Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1 text-sm text-red-500">
              <AlertCircle className="h-4 w-4" /> Failed to save
            </span>
          )}
          {saveStatus === "idle" && (
            <span className="text-muted-foreground text-sm">Changes are applied when you save</span>
          )}
        </div>
        <Button onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {saving ? "Saving" : "Save"}
        </Button>
      </GlassPanelFooter>
    </GlassPanel>
  );
}
