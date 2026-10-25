"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageTabStrip } from "@/components/layout/page";
import { fetchJson, patchJson } from "@/lib/http";
import {
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
  Bell,
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
import { NotificationsTab } from "./tabs/notifications-tab";
import type { UserSettings } from "./types";

const SETTINGS_TABS = [
  "ai",
  "persona",
  "email",
  "calendar",
  "notifications",
  "appearance",
  "memories",
  "account",
  "integrations",
  "tools",
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (SETTINGS_TABS as readonly string[]).includes(value);
}

export default function SettingsPage() {
  // The tab lives in the query string so refresh and back/forward keep the
  // user on the page they were on instead of snapping back to the first tab.
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlTab = searchParams.get("tab");
  const activeTab: SettingsTab =
    urlTab === "mcp" ? "integrations" : isSettingsTab(urlTab) ? urlTab : "ai";

  const handleTabChange = (tab: string) => {
    if (isSettingsTab(tab)) {
      router.replace(`/dashboard/settings?tab=${tab}`);
    }
  };

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

  /**
   * Save one change on its own. Appearance switches apply as they are flipped
   * rather than waiting for a Save button, and adopting the response keeps the
   * state the other tabs send whole from undoing the change.
   */
  const handlePatchSettings = useCallback(async (patch: Partial<UserSettings>) => {
    setSaving(true);
    try {
      const data = await patchJson<{ settings: UserSettings }>("/api/settings", patch);
      setSettings(data.settings);
      setSaveStatus("success");
    } catch (err) {
      console.error("Failed to save settings:", err);
      setSaveStatus("error");
    }
    setSaving(false);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <Page>
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* Tab strip. pinned, swipe-scrollable, no visible scrollbar */}
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
            <TabsTrigger value="notifications" className="gap-2">
              <Bell className="h-4 w-4" />
              Notifications
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

        {/* Tab content. the only scroll region */}
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

        <TabsContent value="notifications" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <NotificationsTab settings={settings} onPatch={handlePatchSettings} saving={saving} />
        </TabsContent>

        <TabsContent value="appearance" className="min-h-0 flex-1 space-y-6 overflow-y-auto">
          <AppearanceTab settings={settings} onPatch={handlePatchSettings} saving={saving} />
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
