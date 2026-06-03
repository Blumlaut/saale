"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { fetchJson, patchJson } from "@/lib/http";
import { Bot, Loader2, CheckCircle, AlertCircle } from "lucide-react";
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

export default function AdminModelsPage() {
  const [availableModels, setAvailableModels] = useState<Record<string, AvailableModel[]>>({});
  const [availableProviders, setAvailableProviders] = useState<AvailableProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  const [adminSettings, setAdminSettings] = useState<AdminSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);

  // Provider toggle state: { [providerId]: boolean }
  const [providerEnabled, setProviderEnabled] = useState<Record<string, boolean>>({});
  // Per-model toggle state: { [providerId]: Set<modelId> }
  const [modelEnabled, setModelEnabled] = useState<Record<string, Set<string>>>({});

  // Load available models from providers
  const loadModels = useCallback(async () => {
    try {
      const data = await fetchJson<{
        models: Record<string, AvailableModel[]>;
        providers: AvailableProvider[];
      }>("/api/providers/models");
      setAvailableModels(data.models ?? {});
      setAvailableProviders(data.providers ?? []);
    } catch {
      // No models available yet
    }
  }, []);

  // Load admin settings (must run after loadModels so we have provider list)
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
    loadModels()
      .then(() => loadSettings())
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize providerEnabled for providers not in config (default to enabled)
  useEffect(() => {
    if (availableProviders.length > 0) {
      setProviderEnabled((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const prov of availableProviders) {
          if (!(prov.id in next)) {
            next[prov.id] = true;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [availableProviders]);

  // Auto-clear save status
  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

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

  const handleSave = useCallback(async () => {
    if (!adminSettings) return;
    setSaving(true);

    // Build globalProviderModels from toggle state
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

  if (loading || settingsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

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
              Manage which models are available globally
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
          <Button size="sm" disabled={saving} onClick={handleSave}>
            {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>

      {/* No providers configured */}
      {availableProviders.length === 0 && (
        <GlassPanel>
          <GlassPanelContent>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Bot className="text-muted-foreground/50 mb-3 h-8 w-8" />
              <p className="text-sm font-medium">No providers configured</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Add model providers in your user settings first
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                onClick={() => (window.location.href = "/dashboard/settings?tab=providers")}
              >
                Go to settings
              </Button>
            </div>
          </GlassPanelContent>
        </GlassPanel>
      )}

      {/* Provider cards */}
      {availableProviders.map((provider) => {
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
    </div>
  );
}
