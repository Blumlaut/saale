"use client";

import { useState, useCallback } from "react";
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
import { Wrench, Info, ChevronDown, ChevronRight } from "lucide-react";
import { SaveFooter } from "../components/save-footer";
import type { UserSettings, ToolConfig } from "../types";
import type { ToolPolicy } from "@/lib/pi/tool-infos";
import { DEFAULT_TOOL_CONFIG, TOOL_CATEGORIES } from "@/lib/pi/tool-categories";
import { getToolsByCategory, getDefaultPolicy } from "@/lib/pi/tool-infos";

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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

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
      <GlassPanel>
        <GlassPanelContent className="p-0">
          {/* Header */}
          <div className="px-6 pt-5 pb-4">
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Wrench className="h-5 w-5" />
              Tools
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Configure which tools are enabled and how they are approved.
            </p>
            <div className="liquid-glass-inner mt-3 flex items-start gap-2 rounded-xl border-0 px-4 py-3">
              <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-muted-foreground text-xs">
                Toggle a category on/off to enable or disable it by default. Expand a category to
                configure per-tool approval policies. <b>Allow</b> — runs automatically. <b>Auto</b>{" "}
                — auto-approves safe commands, asks for risky ones (infra exec only). <b>Ask</b> —
                requires your approval. <b>Block</b> — never runs. Tools from an MCP server follow
                their server&apos;s approval setting in the MCP tab.
              </p>
            </div>
          </div>

          <Separator />

          {/* Category sections */}
          <div className="px-6 py-4">
            <div className="space-y-1">
              {TOOL_CATEGORIES.map((category, index) => {
                const enabled = !!toolConfig[category.key];
                const isExpanded = !!expanded[category.key];
                const tools = getToolsByCategory(category.key);
                const Icon = category.icon;

                return (
                  <div key={category.key}>
                    {index > 0 && <Separator className="mx-2" />}

                    {/* Category header — toggle + expand */}
                    <div className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-3">
                        <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
                        <div className="space-y-0.5">
                          <Label className="text-sm font-medium">{category.label}</Label>
                          <p className="text-muted-foreground text-xs">{category.description}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {/* Expand/collapse chevron — only show if category has tools */}
                        {tools.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(category.key)}
                            className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0"
                            aria-label={isExpanded ? "Collapse" : "Expand"}
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                        )}

                        <Switch
                          checked={enabled}
                          onCheckedChange={() => handleToggle(category.key)}
                        />
                      </div>
                    </div>

                    {/* Per-tool policies — collapsed when category is off or not expanded */}
                    {!enabled && tools.length > 0 && (
                      <div className="pb-3 pl-7">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(category.key)}
                          className="text-muted-foreground hover:text-foreground text-xs"
                        >
                          Show tool policies…
                        </button>
                      </div>
                    )}

                    {isExpanded && tools.length > 0 && (
                      <div className="pb-3 pl-7">
                        <div className="space-y-1.5">
                          {tools.map((tool) => {
                            const policy = toolPolicies[tool.name] ?? getDefaultPolicy(tool.name);

                            return (
                              <div
                                key={tool.name}
                                className="flex items-center justify-between gap-3"
                              >
                                <div className="min-w-0 space-y-0">
                                  <span className="text-sm">{tool.label}</span>
                                  <span className="text-muted-foreground text-xs">
                                    {" "}
                                    - {tool.description}
                                  </span>
                                </div>
                                <Select
                                  value={policy}
                                  onValueChange={(value) => {
                                    if (value) handlePolicyChange(tool.name, value as ToolPolicy);
                                  }}
                                >
                                  <SelectTrigger className="w-24 shrink-0">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent align="end">
                                    <SelectItem value="allow">Allow</SelectItem>
                                    {(tool.name === "infra_exec" || tool.name === "bash") && (
                                      <SelectItem value="auto">Auto</SelectItem>
                                    )}
                                    <SelectItem value="ask">Ask</SelectItem>
                                    <SelectItem value="off">Block</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
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
