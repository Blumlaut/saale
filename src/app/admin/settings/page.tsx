"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Page, PageToolbar, PageScroll } from "@/components/layout/page";
import { fetchJson, patchJson } from "@/lib/http";
import { ModelPicker } from "@/components/shared/model-picker";
import { Loader2, CheckCircle, AlertCircle, Brain } from "lucide-react";

interface AdminSettings {
  signupsEnabled: boolean;
  globalModelProvider: string;
  globalModelName: string;
  globalProviderModels: Record<string, unknown> | null;
}

export default function AdminSettingsPage() {
  const [_settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Local state for toggles
  const [signupsEnabled, setSignupsEnabled] = useState(true);
  const [globalModelId, setGlobalModelId] = useState("");

  // Load admin settings
  useEffect(() => {
    fetchJson<{ settings: AdminSettings }>("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setSignupsEnabled(data.settings.signupsEnabled);
        const modelStr =
          data.settings.globalModelProvider && data.settings.globalModelName
            ? `${data.settings.globalModelProvider}/${data.settings.globalModelName}`
            : "";
        setGlobalModelId(modelStr);
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

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const [provider, ...modelParts] = globalModelId.split("/");
      await patchJson("/api/admin/settings", {
        signupsEnabled,
        globalModelProvider: globalModelId ? provider : "",
        globalModelName: globalModelId ? modelParts.join("/") : "",
      });
      setSaveStatus("success");
    } catch {
      setSaveStatus("error");
    }
    setSaving(false);
  }, [signupsEnabled, globalModelId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <Page>
      {/* Pinned action row — status + Save, no title */}
      <PageToolbar>
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
      </PageToolbar>

      <PageScroll>
        <div className="space-y-6">
          {/* Signups */}
          <GlassPanel>
            <GlassPanelHeader title="Signups" />
            <GlassPanelContent className="p-0">
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <Label className="text-sm font-medium">Allow new registrations</Label>
                  <p className="text-muted-foreground text-xs">
                    When disabled, the registration page will show a message instead of the signup
                    form
                  </p>
                </div>
                <Switch checked={signupsEnabled} onCheckedChange={setSignupsEnabled} />
              </div>
            </GlassPanelContent>
          </GlassPanel>

          {/* Global default model */}
          <GlassPanel>
            <GlassPanelHeader title="Default Model" />
            <GlassPanelContent className="p-0">
              <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Label className="text-sm font-medium">Global fallback model</Label>
                  <p className="text-muted-foreground text-xs">
                    Used when a user hasn&apos;t configured their own model. Leave empty to require
                    users to select one.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!globalModelId && <Brain className="text-muted-foreground h-4 w-4" />}
                  <ModelPicker value={globalModelId} onChange={setGlobalModelId} />
                </div>
              </div>
            </GlassPanelContent>
          </GlassPanel>

          {/* Info */}
          <GlassPanel>
            <GlassPanelHeader title="About" />
            <GlassPanelContent>
              <div className="text-muted-foreground space-y-3 text-sm">
                <p>
                  <span className="text-foreground font-medium">Model Providers</span> — Configure
                  which AI models are available globally in the Models tab.
                </p>
                <Separator />
                <p>
                  <span className="text-foreground font-medium">Users</span> — Manage user accounts,
                  roles, and access in the Users tab.
                </p>
              </div>
            </GlassPanelContent>
          </GlassPanel>
        </div>
      </PageScroll>
    </Page>
  );
}
