"use client";

import { useEffect, useState, useCallback } from "react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Page,
  PageAction,
  PageActions,
  PageScroll,
  PageSection,
  PageStatus,
} from "@/components/layout/page";
import { fetchJson, patchJson } from "@/lib/http";
import { TelegramBotPanel } from "@/components/admin/telegram-bot-panel";
import { BrandingPanel } from "@/components/admin/branding-panel";
import { Loader2 } from "lucide-react";
import { FEATURES, FEATURE_DEFINITIONS } from "@/lib/permissions/features";
import { normalizeThemeColors, type BrandColors } from "@/lib/branding/theme";
import { reloadBrandingStyles } from "@/lib/branding/client";

interface AdminSettings {
  signupsEnabled: boolean;
  globalModelProvider: string;
  globalModelName: string;
  globalProviderModels: Record<string, unknown> | null;
  featureDefaults: Record<string, boolean> | null;
  themeColors: unknown;
  brandingAvatar: string;
}

export default function AdminSettingsPage() {
  const [_settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");

  // Local state for toggles
  const [signupsEnabled, setSignupsEnabled] = useState(true);
  const [featureDefaults, setFeatureDefaults] = useState<Record<string, boolean>>({});
  const [themeColors, setThemeColors] = useState<BrandColors>({ light: {}, dark: {} });
  const [brandingAvatar, setBrandingAvatar] = useState("");

  // Load admin settings
  useEffect(() => {
    fetchJson<{ settings: AdminSettings }>("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setSignupsEnabled(data.settings.signupsEnabled);
        setFeatureDefaults(data.settings.featureDefaults ?? {});
        setThemeColors(normalizeThemeColors(data.settings.themeColors));
        setBrandingAvatar(data.settings.brandingAvatar ?? "");
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load admin settings:", err);
        setLoading(false);
      });
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
        featureDefaults,
        themeColors,
      });
      reloadBrandingStyles();
      setSaveStatus("success");
    } catch (err) {
      console.error("Failed to save admin settings:", err);
      setSaveStatus("error");
    }
    setSaving(false);
  }, [signupsEnabled, featureDefaults, themeColors]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <Page className="gap-0">
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <PageActions>
          <PageStatus status={saveStatus} />
          <PageAction label="Save" busy={saving} onClick={handleSave} />
        </PageActions>

        <PageScroll>
          <PageSection title="Signups">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <Label className="text-sm font-medium">Allow new registrations</Label>
                <p className="text-muted-foreground text-xs">
                  When disabled, the registration page shows a message instead of the signup form
                </p>
              </div>
              <Switch checked={signupsEnabled} onCheckedChange={setSignupsEnabled} />
            </div>
          </PageSection>

          {/* Regular accounts that have no override of their own */}
          <PageSection title="Default Features">
            <p className="text-muted-foreground border-b px-4 py-3 text-xs">
              Applied to every regular account without its own switches. Admin accounts always have
              everything.
            </p>
            <div className="divide-y">
              {FEATURES.map((feature) => {
                const definition = FEATURE_DEFINITIONS[feature];
                return (
                  <div key={feature} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <Label className="text-sm font-medium">{definition.label}</Label>
                      <p className="text-muted-foreground text-xs">{definition.description}</p>
                    </div>
                    <Switch
                      checked={featureDefaults[feature] ?? definition.defaultOn}
                      onCheckedChange={(v) =>
                        setFeatureDefaults((prev) => ({ ...prev, [feature]: v }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          </PageSection>

          <TelegramBotPanel flat />

          <BrandingPanel
            flat
            colors={themeColors}
            onColorsChange={setThemeColors}
            avatar={brandingAvatar}
            onAvatarChange={setBrandingAvatar}
          />
        </PageScroll>
      </GlassPanel>
    </Page>
  );
}
