"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Label } from "@/components/ui/label";
import { Palette } from "lucide-react";
import { useTheme } from "next-themes";

export function AppearanceTab() {
  const { theme, setTheme } = useTheme();

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        <div>
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Palette className="h-5 w-5" />
            Appearance
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">Customize the look and feel of Saale</p>
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
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
