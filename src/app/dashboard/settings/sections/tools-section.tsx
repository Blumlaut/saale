"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { DecisionModelField } from "@/components/shared/decision-model-field";
import { ToolCategoryRow } from "@/components/shared/tool-category-row";
import { ScopeSwitches, ToolScopeHeader } from "@/components/shared/tool-scopes";
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
import { AutosavedPage } from "../components/save-state";
import { useUserSettings } from "../components/user-settings-provider";
import type { ToolConfig, ToolExposureConfig } from "../types";
import type { ToolInfo, ToolPolicy } from "@/lib/pi/tool-infos";
import {
  DEFAULT_TOOL_CONFIG,
  DEFAULT_TOOL_EXPOSURE,
  isCategoryEnabled,
  resolveCategoryExposure,
  TOOL_CATEGORIES,
  TOOL_EXPOSURES,
  type ToolExposure,
} from "@/lib/pi/tool-categories";
import { getToolsByCategory, getUncategorizedTools, getDefaultPolicy } from "@/lib/pi/tool-infos";
import { resolveCoderToolConfig } from "@/lib/pi/coder-tools";
import { useMcpServers, type McpServer } from "@/hooks/use-mcp-servers";
import { SETTINGS_ROOT } from "@/lib/navigation/settings-nav";

/** Exposure option descriptions, for the selected value's hint line. */
const exposureDescriptions = Object.fromEntries(
  TOOL_EXPOSURES.map((option) => [option.value, option.description]),
) as Record<ToolExposure, string>;

export function ToolsSection() {
  const { settings, update, saveState } = useUserSettings();
  const toolConfig = (settings?.defaultToolConfig ?? DEFAULT_TOOL_CONFIG) as Required<ToolConfig>;
  const coderToolConfig = resolveCoderToolConfig(settings?.coderToolConfig);
  const toolPolicies = (settings?.toolPolicies ?? {}) as Record<string, ToolPolicy>;
  const toolExposure = (settings?.toolExposure ?? {}) as ToolExposureConfig;
  const decisionModel = settings?.approvalDecisionModel ?? null;
  const uncategorizedTools = getUncategorizedTools();
  const mcp = useMcpServers();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleToggle = (key: string) => {
    if (!settings) return;
    // The stored config is sparse and can predate a category, so an absent key
    // means "at the registry default". flip that, not `undefined`.
    const updated = { ...toolConfig, [key]: !isCategoryEnabled(toolConfig, key) };
    update({ defaultToolConfig: updated });
  };

  /** A coder toggle, written to the same column shape as `defaultToolConfig`. */
  const handleCoderToggle = (key: string) => {
    if (!settings) return;
    const categoryKey = key as (typeof TOOL_CATEGORIES)[number]["key"];
    update({
      coderToolConfig: {
        ...coderToolConfig,
        [categoryKey]: !coderToolConfig[categoryKey],
      },
    });
  };

  /** A server's scope is its own row, so it saves on the click. */
  const handleMcpScopeChange = async (
    server: McpServer,
    patch: { chatEnabled?: boolean; coderEnabled?: boolean },
  ) => {
    try {
      await mcp.updateServer(server.id, patch);
    } catch (err) {
      console.error(`Failed to change the scope of MCP server "${server.name}":`, err);
    }
  };

  const handlePolicyChange = (toolName: string, policy: ToolPolicy) => {
    if (!settings) return;
    update({ toolPolicies: { ...toolPolicies, [toolName]: policy } });
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
    update({ toolExposure: Object.keys(next).length > 0 ? next : null });
  };

  return (
    <AutosavedPage state={saveState}>
      <GlassPanel>
        <GlassPanelContent className="p-0">
          {/* Header */}
          <div className="px-4 pt-5 pb-4 md:px-6">
            <h3 className="flex items-center gap-2 text-lg font-medium">
              <Wrench className="h-5 w-5" />
              Tools
            </h3>
            <p className="text-muted-foreground mt-1 text-sm">
              Configure which tools are enabled, how they reach the model, and how they are
              approved.
            </p>
            <div className="bg-muted mt-3 flex items-start gap-2 rounded-xl border-0 px-4 py-3">
              <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-muted-foreground text-xs">
                Chat is what a new conversation starts with, Coder what a new coding chat starts
                with. Expand a category to set how its tools reach the model and to approve each
                tool. Always available means the model sees the tools on every message. Via codemode
                hides them; the model writes a short script to call them. Search only hides them
                until a tool search finds them. Allow runs automatically, Auto asks for risky
                commands, Ask requires approval, Block never runs. MCP servers connect while the MCP
                category is on, and their calls follow the approval setting of each server.
              </p>
            </div>
          </div>

          <Separator />

          {/* One row per category, with a switch for each scope it applies to. */}
          <div className="px-4 py-4 md:px-6">
            <ToolScopeHeader />

            <div className="space-y-1">
              {TOOL_CATEGORIES.map((category, index) => {
                const chatEnabled = isCategoryEnabled(toolConfig, category.key);
                const coderEnabled = !!coderToolConfig[category.key];
                const isExpanded = !!expanded[category.key];
                const tools = getToolsByCategory(category.key);
                const exposure = resolveCategoryExposure(toolExposure, category.key);

                return (
                  <div key={category.key}>
                    {index > 0 && <Separator className="mx-2" />}

                    <ToolCategoryRow
                      category={category}
                      controls={
                        <ScopeSwitches
                          label={category.label}
                          chat={chatEnabled}
                          coder={coderEnabled}
                          onChatChange={() => handleToggle(category.key)}
                          onCoderChange={() => handleCoderToggle(category.key)}
                        />
                      }
                      trailing={
                        <button
                          type="button"
                          onClick={() => toggleExpanded(category.key)}
                          className="text-muted-foreground hover:text-foreground h-6 w-6 shrink-0"
                          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${category.label}`}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      }
                    />

                    {/* Per-tool policies. collapsed when the category is off everywhere */}
                    {!chatEnabled && !coderEnabled && tools.length > 0 && (
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

                    {isExpanded && (
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

                        {/* MCP has no catalog tools: the servers are the rows. */}
                        {category.key === "mcp" && (
                          <div className="space-y-1.5">
                            {mcp.loading ? (
                              <p className="text-muted-foreground text-xs">Loading servers…</p>
                            ) : mcp.error ? (
                              <p className="text-destructive text-xs">{mcp.error}</p>
                            ) : mcp.servers.length === 0 ? (
                              <p className="text-muted-foreground text-xs">
                                No servers yet. Add one under{" "}
                                <Link
                                  href={`${SETTINGS_ROOT}/integrations`}
                                  className="text-foreground underline underline-offset-2"
                                >
                                  Integrations
                                </Link>
                                .
                              </p>
                            ) : (
                              mcp.servers.map((server) => (
                                <div
                                  key={server.id}
                                  className="flex flex-wrap items-center justify-between gap-3"
                                >
                                  <div className="min-w-0 flex-1">
                                    <span className="text-sm">{server.name}</span>
                                    {!server.enabled && (
                                      <span className="text-muted-foreground text-xs"> - off</span>
                                    )}
                                    {server.description && (
                                      <p className="text-muted-foreground text-xs">
                                        {server.description}
                                      </p>
                                    )}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-3">
                                    <ScopeSwitches
                                      label={server.name}
                                      chat={server.chatEnabled}
                                      coder={server.coderEnabled}
                                      disabled={!server.enabled}
                                      onChatChange={(checked) =>
                                        void handleMcpScopeChange(server, { chatEnabled: checked })
                                      }
                                      onCoderChange={(checked) =>
                                        void handleMcpScopeChange(server, { coderEnabled: checked })
                                      }
                                    />
                                    <span className="w-6" aria-hidden />
                                  </div>
                                </div>
                              ))
                            )}
                          </div>
                        )}

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
            <div className="px-4 pb-4 md:px-6">
              <Separator className="mx-2" />
              <div className="flex items-center gap-3 py-3">
                <Code2 className="text-muted-foreground h-4 w-4 shrink-0" />
                <div className="space-y-0.5">
                  <Label className="text-sm font-medium">Always active</Label>
                  <p className="text-muted-foreground text-xs">
                    Not tied to a category. active whenever the session can call tools
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

          {/* What Auto runs on its own, judged by a model instead of the command */}
          <div className="px-4 pb-4 md:px-6">
            <Separator className="mx-2" />
            <div className="pt-3">
              <DecisionModelField
                value={decisionModel}
                onChange={(value) => update({ approvalDecisionModel: value })}
                fallback={settings?.instanceApprovalDecisionModel ?? null}
                fallbackLabel="the instance default"
                endpoint="/api/providers/models"
              />
            </div>
          </div>
        </GlassPanelContent>
      </GlassPanel>
    </AutosavedPage>
  );
}

/**
 * One tool's approval policy.
 *
 * `Auto` is offered where it means something: the tools whose default policy is
 * `auto` are the ones whose gate decides from what the call does. a shell
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
