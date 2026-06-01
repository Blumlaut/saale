"use client";

import { GlassPanel, GlassPanelContent, GlassPanelFooter } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Bot, Loader2, CheckCircle, AlertCircle, Sparkles, Brain, Zap, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useMemo } from "react";
import type { UserSettings, AvailableModel, AvailableProvider } from "../types";

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

  const selectedProvider = providersWithModels.find((p) => p.id === settings?.defaultModelProvider);

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
            Choose your default model and configure reasoning depth.
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
                          settings?.defaultModelProvider === provider.id &&
                          settings?.defaultModelName === model.id;

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
                            onClick={() => {
                              if (settings) {
                                onSettingsChange({
                                  ...settings,
                                  defaultModelProvider: provider.id,
                                  defaultModelName: model.id,
                                });
                              }
                            }}
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

          {/* Thinking Level */}
          <div className="w-full lg:w-[280px]">
            <div className="sticky top-6 space-y-6">
              {/* Selected model summary */}
              {selectedProvider && settings?.defaultModelName && (
                <div className="border-border/50 bg-background/40 rounded-2xl border p-4">
                  <p className="text-muted-foreground text-xs">Current model</p>
                  <p className="mt-1 text-sm font-medium">{settings.defaultModelName}</p>
                  <p className="text-muted-foreground text-xs">{selectedProvider.name}</p>
                </div>
              )}

              {/* Thinking level selector */}
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
