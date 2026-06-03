"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel, GlassPanelHeader, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { fetchJson, patchJson } from "@/lib/http";
import { Settings, Loader2, CheckCircle, AlertCircle } from "lucide-react";

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

  // Load admin settings
  useEffect(() => {
    fetchJson<{ settings: AdminSettings }>("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setSignupsEnabled(data.settings.signupsEnabled);
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
      await patchJson("/api/admin/settings", {
        signupsEnabled,
      });
      setSaveStatus("success");
    } catch {
      setSaveStatus("error");
    }
    setSaving(false);
  }, [signupsEnabled]);

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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GlassPanel className="rounded-xl p-2">
            <Settings className="text-muted-foreground h-4 w-4 md:h-5 md:w-5" />
          </GlassPanel>
          <div>
            <h1 className="text-lg font-semibold tracking-tight md:text-2xl">Settings</h1>
            <p className="text-muted-foreground text-xs md:text-sm">Global application settings</p>
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

      {/* Signups */}
      <GlassPanel>
        <GlassPanelHeader title="Signups" />
        <GlassPanelContent className="p-0">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <Label className="text-sm font-medium">Allow new registrations</Label>
              <p className="text-muted-foreground text-xs">
                When disabled, the registration page will show a message instead of the signup form
              </p>
            </div>
            <Switch checked={signupsEnabled} onCheckedChange={setSignupsEnabled} />
          </div>
        </GlassPanelContent>
      </GlassPanel>

      {/* Info */}
      <GlassPanel>
        <GlassPanelHeader title="About" />
        <GlassPanelContent>
          <div className="text-muted-foreground space-y-3 text-sm">
            <p>
              <span className="text-foreground font-medium">Model Providers</span> — Configure which
              AI models are available globally in the Models tab.
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
  );
}
