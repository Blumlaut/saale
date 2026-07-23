"use client";

import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Wrench, Info, Shield } from "lucide-react";
import { SaveFooter } from "../components/save-footer";
import type { UserSettings, ToolConfig, ToolPolicy } from "../types";
import { DEFAULT_TOOL_CONFIG, TOOL_CATEGORIES } from "@/lib/pi/tool-categories";
import { ALL_TOOL_INFOS } from "@/lib/pi/tool-infos";

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
  const toolPolicies = (settings?.toolPolicies ?? {}) as Record<string, ToolPolicy>;

  const handleToggle = (key: string) => {
    if (!settings) return;
    const updated = { ...toolConfig, [key]: !toolConfig[key] };
    onSettingsChange({
      ...settings,
      defaultToolConfig: updated,
    });
  };

  const handlePolicyChange = (toolName: string, policy: ToolPolicy) => {
    if (!settings) return;
    const updated = { ...toolPolicies, [toolName]: policy };
    onSettingsChange({
      ...settings,
      toolPolicies: updated,
    });
  };

  return (
    <div className="space-y-6">
      {/* Tool categories */}
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
                      <Switch
                        checked={enabled}
                        onCheckedChange={() => handleToggle(category.key)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </GlassPanelContent>
      </GlassPanel>

      {/* Tool approval policies */}
      <GlassPanel>
        <GlassPanelContent className="p-0">
          <div className="px-6 pt-5 pb-4">
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Shield className="h-5 w-5" />
              Tool Approval Policies
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Control how tool calls are handled. By default, all tools run automatically.
            </p>
            <div className="liquid-glass-inner mt-3 flex items-start gap-2 rounded-xl border-0 px-4 py-3">
              <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-muted-foreground text-xs">
                <b>Allow</b> — tool runs automatically. <b>Ask</b> — requires your approval before
                running. <b>Block</b> — tool is disabled and will never run.
              </p>
            </div>
          </div>

          <Separator />

          {/* Per-tool policy selectors */}
          <div className="px-6 py-4">
            <div className="space-y-2">
              {ALL_TOOL_INFOS.map((tool) => {
                const policy = toolPolicies[tool.name] ?? "yolo";

                return (
                  <div key={tool.name} className="flex items-center justify-between gap-3 py-1.5">
                    <div className="min-w-0 space-y-0.5">
                      <Label className="text-sm font-medium">{tool.label}</Label>
                      <p className="text-muted-foreground text-xs">{tool.description}</p>
                    </div>
                    <Select
                      value={policy}
                      onValueChange={(value) => {
                        if (value) handlePolicyChange(tool.name, value as ToolPolicy);
                      }}
                    >
                      <SelectTrigger className="w-28 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        <SelectItem value="yolo">Allow</SelectItem>
                        <SelectItem value="ask">Ask</SelectItem>
                        <SelectItem value="off">Block</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>
        </GlassPanelContent>
      </GlassPanel>

      <SaveFooter saving={saving} saveStatus={saveStatus} onSave={onSave} />
    </div>
  );
}
