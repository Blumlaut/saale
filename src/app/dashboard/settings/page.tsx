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
  PenTool,
  Calendar,
  Wrench,
  Brain,
} from "lucide-react";
import { AiModelsTab } from "./tabs/ai-models-tab";
import { AgentPersonaTab } from "./tabs/agent-persona-tab";
import { EmailTab } from "./tabs/email-tab";
import { CalendarTab } from "./tabs/calendar-tab";
import { AppearanceTab } from "./tabs/appearance-tab";
import { ToolsTab } from "./tabs/tools-tab";
import { MemoriesTab } from "./tabs/memories-tab";
import type { UserSettings } from "./types";

export default function SettingsPage() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Load user settings
  useEffect(() => {
    fetchJson<{ settings: UserSettings }>("/api/settings")
      .then((data) => {
        setSettings(data.settings);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3">
          <GlassPanel className="rounded-xl p-2">
            <SettingsIcon className="text-muted-foreground h-4 w-4 md:h-5 md:w-5" />
          </GlassPanel>
          <div>
            <h1 className="text-lg font-semibold tracking-tight md:text-2xl">Settings</h1>
            <p className="text-muted-foreground text-xs md:text-sm">
              Configure your AI models, email accounts, and preferences
            </p>
          </div>
        </div>

        <Tabs defaultValue="ai" className="space-y-6">
          <div className="overflow-x-auto pb-1">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="ai" className="gap-2">
                <Bot className="h-4 w-4" />
                AI &amp; Models
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
              <TabsTrigger value="memories" className="gap-2">
                <Brain className="h-4 w-4" />
                Memories
              </TabsTrigger>
              <TabsTrigger value="tools" className="gap-2">
                <Wrench className="h-4 w-4" />
                Tools
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="ai" className="space-y-6">
            <AiModelsTab
              settings={settings}
              onSettingsChange={setSettings}
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

          <TabsContent value="memories" className="space-y-6">
            <MemoriesTab />
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
    </div>
  );
}
