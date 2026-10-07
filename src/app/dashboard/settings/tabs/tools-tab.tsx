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
import { Wrench, Info, ChevronDown, ChevronRight, Code2 } from "lucide-react";
import { SaveFooter } from "../components/save-footer";
import type { UserSettings, ToolConfig, ToolExposureConfig } from "../types";
import type { ToolInfo, ToolPolicy } from "@/lib/pi/tool-infos";
import {
  DEFAULT_TOOL_CONFIG,
  DEFAULT_TOOL_EXPOSURE,
  isCategoryEnabled,
  TOOL_CATEGORIES,
  TOOL_EXPOSURES,
  type ToolExposure,
} from "@/lib/pi/tool-categories";
import { getToolsByCategory, getUncategorizedTools, getDefaultPolicy } from "@/lib/pi/tool-infos";

interface ToolsTabProps {
  settings: UserSettings | null;
  onSettingsChange: (settings: UserSettings) => void;
  saving: boolean;
  saveStatus: "idle" | "success" | "error";
  onSave: () => Promise<void>;
}

/** Exposure option descriptions, for the selected value's hint line. */
const exposureDescriptions = Object.fromEntries(
  TOOL_EXPOSURES.map((option) => [option.value, option.description]),
) as Record<ToolExposure, string>;

export function ToolsTab({
  settings,
  onSettingsChange,
  saving,
  saveStatus,
  onSave,
}: ToolsTabProps) {
  const toolConfig = (settings?.defaultToolConfig ?? DEFAULT_TOOL_CONFIG) as Required<ToolConfig>;
  const toolPolicies = (settings?.toolPolicies ?? {}) as Record<string, ToolPolicy>;
  const toolExposure = (settings?.toolExposure ?? {}) as ToolExposureConfig;
  const uncategorizedTools = getUncategorizedTools();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleToggle = (key: string) => {
    if (!settings) return;
    // The stored config is sparse and can predate a category, so an absent key
    // means "at the registry default" — flip that, not `undefined`.
    const updated = { ...toolConfig, [key]: !isCategoryEnabled(toolConfig, key) };
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

  const handleExposureChange = (categoryKey: string, level: ToolExposure) => {
    if (!settings) return;
    // Each category's registry default is stored as absence, so the row only
    // holds categories the user actually changed.
    const next: ToolExposureConfig = { ...toolExposure };
    const key = categoryKey as keyof ToolExposureConfig;
    if (level === DEFAULT_TOOL_EXPOSURE[key]) {
      delete next[key];
    } else {
      next[key] = level;
    }
    onSettingsChange({
      ...settings,
      toolExposure: Object.keys(next).length > 0 ? next : null,
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
              Configure which tools are enabled, how they reach the model, and how they are
              approved.
            </p>
            <div className="liquid-glass-inner mt-3 flex items-start gap-2 rounded-xl border-0 px-4 py-3">
              <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-muted-foreground text-xs">
                Toggle a category on/off to enable or disable it by default. Expand a category to
                choose how its tools reach the model and configure per-tool approval policies.{" "}
                <b>Always available</b> — the model sees the tools on every message.{" "}
                <b>Via codemode</b> — hidden from the model; it writes a short script to call them.{" "}
                <b>Search only</b> — hidden until found with a tool search. The last two save
                context on categories you rarely use. <b>Allow</b> — runs automatically. <b>Auto</b>{" "}
                — decides from what the call does: risky commands, and scripts that reach a tool
                needing approval, ask; everything else runs. <b>Ask</b> — requires your approval.{" "}
                <b>Block</b> — never runs. Tools from an MCP server follow their server&apos;s
                approval setting in the MCP tab.
              </p>
            </div>
          </div>

          <Separator />

          {/* Category sections */}
          <div className="px-6 py-4">
            <div className="space-y-1">
              {TOOL_CATEGORIES.map((category, index) => {
                const enabled = isCategoryEnabled(toolConfig, category.key);
                const isExpanded = !!expanded[category.key];
                const tools = getToolsByCategory(category.key);
                const exposure =
                  toolExposure[category.key] ?? DEFAULT_TOOL_EXPOSURE[category.key] ?? "direct";
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
                        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                          <div className="min-w-0">
                            <Label className="text-sm">Availability</Label>
                            <p className="text-muted-foreground text-xs">
                              {exposureDescriptions[exposure]}
                            </p>
                          </div>
                          <Select
                            value={exposure}
                            onValueChange={(value) => {
                              if (value) handleExposureChange(category.key, value as ToolExposure);
                            }}
                          >
                            <SelectTrigger className="w-full shrink-0 sm:w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent align="end">
                              {TOOL_EXPOSURES.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1.5">
                          {tools.map((tool) => (
                            <PolicyRow
                              key={tool.name}
                              tool={tool}
                              policy={toolPolicies[tool.name] ?? getDefaultPolicy(tool.name)}
                              onChange={handlePolicyChange}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tools no category owns: active whatever the switches above say, so
              they carry a policy and no toggle of their own. */}
          {uncategorizedTools.length > 0 && (
            <div className="px-6 pb-4">
              <Separator className="mx-2" />
              <div className="flex items-center gap-3 py-3">
                <Code2 className="text-muted-foreground h-4 w-4 shrink-0" />
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Always active</Label>
                  <p className="text-muted-foreground text-xs">
                    Not tied to a category — active whenever the session can call tools
                  </p>
                </div>
              </div>

              <div className="space-y-1.5 pl-7">
                {uncategorizedTools.map((tool) => (
                  <PolicyRow
                    key={tool.name}
                    tool={tool}
                    policy={toolPolicies[tool.name] ?? getDefaultPolicy(tool.name)}
                    onChange={handlePolicyChange}
                  />
                ))}
              </div>
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <SaveFooter saving={saving} saveStatus={saveStatus} onSave={onSave} />
    </div>
  );
}

/**
 * One tool's approval policy.
 *
 * `Auto` is offered where it means something: the tools whose default policy is
 * `auto` are the ones whose gate decides from what the call does — a shell
 * command, or the tools a script reaches (see the policy docs in
 * `@/lib/pi/tool-infos`). A tool that already carries `auto` keeps the option
 * even when it is not the default, so the value stays selectable.
 */
function PolicyRow({
  tool,
  policy,
  onChange,
}: {
  tool: ToolInfo;
  policy: ToolPolicy;
  onChange: (toolName: string, policy: ToolPolicy) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 space-y-0">
        <span className="text-sm">{tool.label}</span>
        <span className="text-muted-foreground text-xs"> - {tool.description}</span>
      </div>
      <Select
        value={policy}
        onValueChange={(value) => {
          if (value) onChange(tool.name, value as ToolPolicy);
        }}
      >
        <SelectTrigger className="w-24 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="allow">Allow</SelectItem>
          {(tool.defaultPolicy === "auto" || policy === "auto") && (
            <SelectItem value="auto">Auto</SelectItem>
          )}
          <SelectItem value="ask">Ask</SelectItem>
          <SelectItem value="off">Block</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
