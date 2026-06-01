"use client";

import { GlassPanel, GlassPanelContent, GlassPanelFooter } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useMemo } from "react";
import { getAllPurposes } from "@/lib/pi/purposes";
import type {
  UserSettings,
  AvailableModel,
  AvailableProvider,
  PurposeModelSelection,
} from "../types";

interface AiModelsTabProps {
  settings: UserSettings | null;
  onSettingsChange: (settings: UserSettings) => void;
  availableModels: Record<string, AvailableModel[]>;
  availableModelProviders: AvailableProvider[];
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  onSave: () => Promise<void>;
}

const thinkingLevels = [
  { id: "off", label: "Off", description: "Fastest responses", icon: Zap },
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

/**
 * Resolve the effective model for a purpose: purpose override → global default.
 */
function resolveEffectiveModel(
  settings: UserSettings | null,
  purposeId: string,
): PurposeModelSelection | null {
  if (!settings) return null;

  // Purpose-specific override
  const overrides = settings.purposeModelOverrides ?? {};
  const override = overrides[purposeId];
  if (override?.provider && override?.model) {
    return override;
  }

  // Global default
  if (settings.defaultModelProvider && settings.defaultModelName) {
    return {
      provider: settings.defaultModelProvider,
      model: settings.defaultModelName,
    };
  }

  return null;
}

export function AiModelsTab({
  settings,
  onSettingsChange,
  availableModels,
  availableModelProviders,
  saving,
  saveStatus,
  onSave,
}: AiModelsTabProps) {
  const [search, setSearch] = useState("");
  const [activePurpose, setActivePurpose] = useState<string>("__default__");

  const purposes = useMemo(() => getAllPurposes(), []);

  // Build a flat list of providers with their models
  const providersWithModels = availableModelProviders
    .map((p) => ({
      ...p,
      models: (availableModels[p.id] ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((p) => p.models.length > 0);

  // Filter by search query
  const filteredProviders = useMemo(() => {
    if (!search.trim()) return providersWithModels;
    const q = search.toLowerCase();
    return providersWithModels
      .map((p) => ({
        ...p,
        models: p.models.filter(
          (m) => m.name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.models.length > 0);
  }, [providersWithModels, search]);

  // Determine which model is selected for the active purpose
  const effectiveModel = useMemo(
    () =>
      activePurpose === "__default__"
        ? settings && settings.defaultModelProvider && settings.defaultModelName
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
      // Setting the global default
      onSettingsChange({
        ...settings,
        defaultModelProvider: providerId,
        defaultModelName: modelId,
      });
    } else {
      // Setting a purpose-specific override
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
            Choose your default model, configure reasoning depth, and assign models per purpose.
          </p>
        </div>

        <Separator />

        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Model Browser */}
          <div className="flex-1">
            <div className="px-6 py-3">
              <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Model
              </Label>
            </div>

            {/* Search */}
            <div className="px-4 pb-2">
              <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                <Input
                  type="text"
                  placeholder="Search models..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-9 pl-9"
                />
              </div>
            </div>

            <ScrollArea className="h-[300px] lg:h-[400px]">
              <div className="px-3 pb-3">
                {providersWithModels.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Sparkles className="text-muted-foreground/50 mb-3 h-8 w-8" />
                    <p className="text-sm font-medium">No models available</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      Add an API key in the Model Providers tab to get started.
                    </p>
                  </div>
                ) : filteredProviders.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-center">
                    <Search className="text-muted-foreground/50 mb-3 h-8 w-8" />
                    <p className="text-sm font-medium">No models match your search</p>
                    <p className="text-muted-foreground mt-1 text-xs">Try a different keyword</p>
                  </div>
                ) : (
                  filteredProviders.map((provider) => (
                    <div key={provider.id} className="mb-1">
                      {/* Provider label */}
                      <div className="px-3 py-2">
                        <span className="text-muted-foreground text-xs font-medium">
                          {provider.name}
                        </span>
                      </div>

                      {/* Models */}
                      {provider.models.map((model) => {
                        const isSelected =
                          effectiveModel?.provider === provider.id &&
                          effectiveModel?.model === model.id;

                        return (
                          <Button
                            key={model.id}
                            variant="ghost"
                            className={cn(
                              "w-full shrink-0 justify-start gap-3 rounded-xl px-3 py-2.5",
                              isSelected
                                ? "bg-primary/10 text-foreground dark:bg-primary/10"
                                : "hover:bg-white/20 dark:hover:bg-white/5",
                            )}
                            onClick={() => handleSelectModel(provider.id, model.id)}
                          >
                            {/* Selection indicator */}
                            <div
                              className={cn(
                                "h-2 w-2 shrink-0 rounded-full transition-colors",
                                isSelected ? "bg-primary" : "bg-muted-foreground/30",
                              )}
                            />

                            {/* Model info */}
                            <div className="min-w-0 flex-1 text-left">
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "truncate text-sm",
                                    isSelected ? "font-medium" : "font-normal",
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
                              </div>
                              {model.contextWindow && model.contextWindow > 0 && (
                                <span className="text-muted-foreground text-xs">
                                  {formatContextWindow(model.contextWindow)} context
                                </span>
                              )}
                            </div>

                            {/* Active check */}
                            {isSelected && <CheckCircle className="text-primary h-4 w-4" />}
                          </Button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Right sidebar: Purpose selector + Thinking level */}
          <div className="w-full lg:w-[280px]">
            <div className="sticky top-6 space-y-6">
              {/* Purpose selector */}
              <div className="space-y-3">
                <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Purpose
                </Label>

                <div className="border-border/50 bg-background/40 space-y-1 rounded-2xl border p-1.5">
                  {/* Global default entry */}
                  <Button
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-3 rounded-xl px-3 py-2.5",
                      activePurpose === "__default__"
                        ? "bg-primary/10 text-foreground"
                        : "hover:bg-white/20 dark:hover:bg-white/5",
                    )}
                    onClick={() => setActivePurpose("__default__")}
                  >
                    <div
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                        activePurpose === "__default__"
                          ? "bg-primary/15 text-primary"
                          : "bg-muted/50 text-muted-foreground",
                      )}
                    >
                      <Globe className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 text-left">
                      <p
                        className={cn(
                          "text-sm leading-none",
                          activePurpose === "__default__" ? "font-medium" : "font-normal",
                        )}
                      >
                        Default
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">Fallback for all</p>
                    </div>
                    {activePurpose === "__default__" && (
                      <CheckCircle className="text-primary h-4 w-4" />
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
                            "w-full justify-start gap-3 rounded-xl px-3 py-2.5",
                            isActive
                              ? "bg-primary/10 text-foreground"
                              : "hover:bg-white/20 dark:hover:bg-white/5",
                          )}
                          onClick={() => setActivePurpose(purpose.id)}
                        >
                          <div
                            className={cn(
                              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                              isActive
                                ? "bg-primary/15 text-primary"
                                : "bg-muted/50 text-muted-foreground",
                            )}
                          >
                            <PurposeIcon className="h-3.5 w-3.5" />
                          </div>
                          <div className="flex-1 text-left">
                            <p
                              className={cn(
                                "text-sm leading-none",
                                isActive ? "font-medium" : "font-normal",
                              )}
                            >
                              {purpose.label}
                            </p>
                            <p className="text-muted-foreground mt-0.5 text-xs">
                              {hasOverride ? "Custom model" : "Using default"}
                            </p>
                          </div>
                          {isActive && <CheckCircle className="text-primary h-4 w-4" />}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Selected model summary */}
              {effectiveModel && selectedProvider && (
                <div className="border-border/50 bg-background/40 rounded-2xl border p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-muted-foreground text-xs">
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
                  <p className="mt-1 text-sm font-medium">{effectiveModel.model}</p>
                  <p className="text-muted-foreground text-xs">{selectedProvider.name}</p>
                </div>
              )}

              {/* Thinking level selector (only for default) */}
              {activePurpose === "__default__" && (
                <div className="space-y-3">
                  <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Thinking Level
                  </Label>

                  <div className="border-border/50 bg-background/40 space-y-1 rounded-2xl border p-1.5">
                    {thinkingLevels.map((level, index) => {
                      const isActive = settings?.defaultThinkingLevel === level.id;
                      const Icon = level.icon;

                      return (
                        <div key={level.id}>
                          {index > 0 && <Separator className="mx-2" />}
                          <Button
                            variant="ghost"
                            className={cn(
                              "w-full shrink-0 justify-start gap-3 rounded-xl px-3 py-2.5",
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
                                "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                                isActive
                                  ? "bg-primary/15 text-primary"
                                  : "bg-muted/50 text-muted-foreground",
                              )}
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </div>
                            <div className="flex-1 text-left">
                              <p
                                className={cn(
                                  "text-sm leading-none",
                                  isActive ? "font-medium" : "font-normal",
                                )}
                              >
                                {level.label}
                              </p>
                              <p className="text-muted-foreground mt-0.5 text-xs">
                                {level.description}
                              </p>
                            </div>
                            {isActive && <CheckCircle className="text-primary h-4 w-4" />}
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

      {/* Footer with save */}
      <GlassPanelFooter>
        <div>
          {saveStatus === "success" && (
            <span className="flex items-center gap-1 text-sm text-emerald-500">
              <CheckCircle className="h-4 w-4" />
              Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1 text-sm text-red-500">
              <AlertCircle className="h-4 w-4" />
              Failed to save
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
