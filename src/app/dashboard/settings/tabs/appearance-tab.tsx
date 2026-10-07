"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Palette } from "lucide-react";
import { useTheme } from "next-themes";
import { useSidebarNav } from "@/components/providers/sidebar-nav-provider";
import { InstallAppCard } from "@/components/pwa/install-app-card";
import { SidebarNavEditor } from "../components/sidebar-nav-editor";
import type { UserSettings } from "../types";

interface AppearanceTabProps {
  settings: UserSettings | null;
  /** Persist a partial change immediately — a toggle takes effect on the spot. */
  onPatch: (patch: Partial<UserSettings>) => Promise<void>;
  saving: boolean;
}

export function AppearanceTab({ settings, onPatch, saving }: AppearanceTabProps) {
  const { theme, setTheme } = useTheme();
  const { entries, saving: savingNav, error, save, reset } = useSidebarNav();
  const compactActivity = settings?.compactActivity ?? true;

  return (
    <div className="space-y-6">
      <GlassPanel>
        <GlassPanelContent className="space-y-6">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Palette className="h-5 w-5" />
              Appearance
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Customize the look and feel of Saale
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Theme</Label>
              <div className="grid grid-cols-3 gap-3">
                {(["light", "dark", "system"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`rounded-2xl border-2 p-4 text-center transition-all ${
                      theme === t
                        ? "border-primary bg-primary/5"
                        : "border-border/50 hover:border-border"
                    }`}
                  >
                    <p className="text-sm font-medium capitalize">{t}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="compact-activity">Compact activity</Label>
                <p className="text-muted-foreground mt-1 text-sm">
                  Show a turn&apos;s reasoning and tool calls as one line each — a running tool
                  count with the tools&apos; own icons — instead of a card per step. Each line
                  expands to the full detail.
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-2 pt-1">
                {saving && <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />}
                <Switch
                  id="compact-activity"
                  checked={compactActivity}
                  disabled={!settings || saving}
                  onCheckedChange={(checked) => onPatch({ compactActivity: checked })}
                />
              </span>
            </div>
          </div>
        </GlassPanelContent>
      </GlassPanel>

      <SidebarNavEditor
        entries={entries}
        saving={savingNav}
        error={error}
        onChange={save}
        onReset={reset}
      />

      <InstallAppCard />
    </div>
  );
}
