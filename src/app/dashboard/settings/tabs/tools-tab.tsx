"use client";

import { GlassPanel, GlassPanelContent, GlassPanelFooter } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Wrench, Loader2, CheckCircle, AlertCircle, Info } from "lucide-react";
import type { UserSettings, ToolConfig } from "../types";
import { DEFAULT_TOOL_CONFIG, TOOL_CATEGORIES } from "@/lib/pi/tool-categories";

interface ToolsTabProps {
  settings: UserSettings | null;
  onSettingsChange: (settings: UserSettings) => void;
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  onSave: () => Promise<void>;
}

export function ToolsTab({
  settings,
  onSettingsChange,
  saving,
  saveStatus,
  onSave,
}: ToolsTabProps) {
  const toolConfig = (settings?.defaultToolConfig ?? DEFAULT_TOOL_CONFIG) as Required<ToolConfig>;

  const handleToggle = (key: string) => {
    if (!settings) return;
    const updated = { ...toolConfig, [key]: !toolConfig[key] };
    onSettingsChange({
      ...settings,
      defaultToolConfig: updated,
    });
  };

  return (
    <GlassPanel>
      <GlassPanelContent className="p-0">
        {/* Header */}
        <div className="px-6 pt-5 pb-4">
          <h3 className="flex items-center gap-2 text-lg font-medium">
            <Wrench className="h-5 w-5" />
            Default Tools
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Configure which tools are enabled by default for new chat sessions.
          </p>
          <div className="liquid-glass-inner mt-3 flex items-start gap-2 rounded-xl border-0 px-4 py-3">
            <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-muted-foreground text-xs">
              These defaults apply to new chat sessions. You can override tools per-session using
              the wrench icon in the chat input bar.
            </p>
          </div>
        </div>

        <Separator />

        {/* Tool toggles */}
        <div className="px-6 py-4">
          <div className="space-y-1">
            {TOOL_CATEGORIES.map((category, index) => {
              const enabled = !!toolConfig[category.key];

              return (
                <div key={category.key}>
                  {index > 0 && <Separator className="mx-2" />}
                  <div className="flex items-center justify-between py-3">
                    <div className="space-y-0.5">
                      <Label className="text-sm font-medium">{category.label}</Label>
                      <p className="text-muted-foreground text-xs">{category.description}</p>
                    </div>
                    <Switch checked={enabled} onCheckedChange={() => handleToggle(category.key)} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </GlassPanelContent>

      {/* Footer with save */}
      <GlassPanelFooter>
        <div>
          {saveStatus === "success" && (
            <span className="flex items-center gap-1 text-sm text-emerald-500">
              <CheckCircle className="h-4 w-4" />
              Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="flex items-center gap-1 text-sm text-red-500">
              <AlertCircle className="h-4 w-4" />
              Failed to save
            </span>
          )}
          {saveStatus === "idle" && (
            <span className="text-muted-foreground text-sm">Changes are applied when you save</span>
          )}
        </div>
        <Button onClick={onSave} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {saving ? "Saving" : "Save"}
        </Button>
      </GlassPanelFooter>
    </GlassPanel>
  );
}
