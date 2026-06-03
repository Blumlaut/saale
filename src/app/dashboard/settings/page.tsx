"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson, patchJson } from "@/lib/http";
import {
  Settings as SettingsIcon,
  Mail,
  Bot,
  Palette,
  Loader2,
  Key,
  PenTool,
  Calendar,
  Wrench,
} from "lucide-react";
import { ProvidersTab } from "./tabs/providers-tab";
import { AiModelsTab } from "./tabs/ai-models-tab";
import { AgentPersonaTab } from "./tabs/agent-persona-tab";
import { EmailTab } from "./tabs/email-tab";
import { CalendarTab } from "./tabs/calendar-tab";
import { AppearanceTab } from "./tabs/appearance-tab";
import { ToolsTab } from "./tabs/tools-tab";
import type {
  UserSettings,
  ConfiguredProvider,
  ProviderInfo,
  AvailableModel,
  AvailableProvider,
} from "./types";

export default function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Providers state (shared between providers and AI tabs)
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [availableProviders, setAvailableProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  // Models state (from Pi SDK, used by AI tab)
  const [availableModels, setAvailableModels] = useState<Record<string, AvailableModel[]>>({});
  const [availableModelProviders, setAvailableModelProviders] = useState<AvailableProvider[]>([]);

  // Load user settings
  useEffect(() => {
    fetchJson<{ settings: UserSettings }>("/api/settings")
      .then((data) => {
        setSettings(data.settings);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Load providers
  const loadProviders = useCallback(async () => {
    try {
      const data = await fetchJson<{
        providers: ConfiguredProvider[];
        availableProviders: ProviderInfo[];
      }>("/api/providers");
      setProviders(data.providers ?? []);
      setAvailableProviders(data.availableProviders ?? []);
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  // Load available models
  const loadModels = useCallback(async () => {
    try {
      const data = await fetchJson<{
        models: Record<string, AvailableModel[]>;
        providers: AvailableProvider[];
      }>("/api/providers/models");
      setAvailableModels(data.models ?? {});
      setAvailableModelProviders(data.providers ?? []);
    } catch {
      // No models available yet
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (!providersLoading) {
      loadModels();
    }
  }, [providersLoading, loadModels]);

  // Reload both providers and models (called after add/remove)
  const reloadProvidersAndModels = useCallback(async () => {
    setProvidersLoading(true);
    await loadProviders();
    await loadModels();
  }, [loadProviders, loadModels]);

  // Auto-clear save status
  useEffect(() => {
    if (saveStatus !== "idle") {
      const timer = setTimeout(() => setSaveStatus("idle"), 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const handleSaveSettings = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await patchJson("/api/settings", settings);
      setSaveStatus("success");
    } catch {
      setSaveStatus("error");
    }
    setSaving(false);
  }, [settings]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <GlassPanel className="rounded-xl p-2">
          <SettingsIcon className="text-muted-foreground h-4 w-4 md:h-5 md:w-5" />
        </GlassPanel>
        <div>
          <h1 className="text-lg font-semibold tracking-tight md:text-2xl">Settings</h1>
          <p className="text-muted-foreground text-xs md:text-sm">
            Configure your AI providers, email accounts, and preferences
          </p>
        </div>
      </div>

      <Tabs defaultValue="providers" className="space-y-6">
        <div className="overflow-x-auto pb-1">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="providers" className="gap-2">
              <Key className="h-4 w-4" />
              Model Providers
            </TabsTrigger>
            <TabsTrigger value="ai" className="gap-2">
              <Bot className="h-4 w-4" />
              AI & Models
            </TabsTrigger>
            <TabsTrigger value="persona" className="gap-2">
              <PenTool className="h-4 w-4" />
              Agent Persona
            </TabsTrigger>
            <TabsTrigger value="email" className="gap-2">
              <Mail className="h-4 w-4" />
              Email
            </TabsTrigger>
            <TabsTrigger value="calendar" className="gap-2">
              <Calendar className="h-4 w-4" />
              Calendar
            </TabsTrigger>
            <TabsTrigger value="appearance" className="gap-2">
              <Palette className="h-4 w-4" />
              Appearance
            </TabsTrigger>
            <TabsTrigger value="tools" className="gap-2">
              <Wrench className="h-4 w-4" />
              Tools
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="providers" className="space-y-6">
          <ProvidersTab
            providers={providers}
            availableProviders={availableProviders}
            providersLoading={providersLoading}
            onReload={reloadProvidersAndModels}
          />
        </TabsContent>

        <TabsContent value="ai" className="space-y-6">
          <AiModelsTab
            settings={settings}
            onSettingsChange={setSettings}
            availableModels={availableModels}
            availableModelProviders={availableModelProviders}
            saving={saving}
            saveStatus={saveStatus}
            onSave={handleSaveSettings}
          />
        </TabsContent>

        <TabsContent value="persona" className="space-y-6">
          <AgentPersonaTab
            settings={settings}
            onSettingsChange={setSettings}
            saving={saving}
            saveStatus={saveStatus}
            onSave={handleSaveSettings}
          />
        </TabsContent>

        <TabsContent value="email" className="space-y-6">
          <EmailTab />
        </TabsContent>

        <TabsContent value="calendar" className="space-y-6">
          <CalendarTab />
        </TabsContent>

        <TabsContent value="appearance" className="space-y-6">
          <AppearanceTab />
        </TabsContent>

        <TabsContent value="tools" className="space-y-6">
          <ToolsTab
            settings={settings}
            onSettingsChange={setSettings}
            saving={saving}
            saveStatus={saveStatus}
            onSave={handleSaveSettings}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
