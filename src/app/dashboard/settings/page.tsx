"use client";

import { useEffect, useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageHeader, PageTabStrip } from "@/components/layout/page";
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
  Shield,
  Plug,
} from "lucide-react";
import { AccountTab } from "./tabs/account-tab";
import { AiModelsTab } from "./tabs/ai-models-tab";
import { AgentPersonaTab } from "./tabs/agent-persona-tab";
import { EmailTab } from "./tabs/email-tab";
import { CalendarTab } from "./tabs/calendar-tab";
import { AppearanceTab } from "./tabs/appearance-tab";
import { ToolsTab } from "./tabs/tools-tab";
import { MemoriesTab } from "./tabs/memories-tab";
import { IntegrationsTab } from "./tabs/integrations-tab";
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
    <Page>
      {/* Header — pinned, never scrolls */}
      <PageHeader
        title="Settings"
        description="Configure your AI models, integrations, email accounts, and preferences"
        icon={<SettingsIcon className="text-muted-foreground h-4 w-4 md:h-5 md:w-5" />}
      />

      <Tabs defaultValue="ai" className="flex min-h-0 flex-1 flex-col">
        {/* Tab strip — pinned, swipe-scrollable, no visible scrollbar */}
        <PageTabStrip className="pb-1">
          <TabsList>
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
            <TabsTrigger value="account" className="gap-2">
              <Shield className="h-4 w-4" />
              Account
            </TabsTrigger>
            <TabsTrigger value="integrations" className="gap-2">
              <Plug className="h-4 w-4" />
              Integrations
            </TabsTrigger>
            <TabsTrigger value="tools" className="gap-2">
              <Wrench className="h-4 w-4" />
              Tools
            </TabsTrigger>
          </TabsList>
        </PageTabStrip>

        {/* Tab content — the only scroll region */}
        <TabsContent value="ai" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <AiModelsTab
            settings={settings}
            onSettingsChange={setSettings}
            saving={saving}
            saveStatus={saveStatus}
            onSave={handleSaveSettings}
          />
        </TabsContent>

        <TabsContent value="persona" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <AgentPersonaTab
            settings={settings}
            onSettingsChange={setSettings}
            saving={saving}
            saveStatus={saveStatus}
            onSave={handleSaveSettings}
          />
        </TabsContent>

        <TabsContent value="email" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <EmailTab />
        </TabsContent>

        <TabsContent value="calendar" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <CalendarTab />
        </TabsContent>

        <TabsContent value="appearance" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <AppearanceTab />
        </TabsContent>

        <TabsContent value="memories" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <MemoriesTab />
        </TabsContent>

        <TabsContent value="account" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <AccountTab />
        </TabsContent>

        <TabsContent value="integrations" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <IntegrationsTab />
        </TabsContent>

        <TabsContent value="tools" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <ToolsTab
            settings={settings}
            onSettingsChange={setSettings}
            saving={saving}
            saveStatus={saveStatus}
            onSave={handleSaveSettings}
          />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
