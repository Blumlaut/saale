"use client";

import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScopeSwitches } from "@/components/shared/tool-scopes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { McpServer } from "@/hooks/use-mcp-servers";
import { isMcpToolPolicy, type McpToolPolicy, type McpToolSummary } from "@/lib/mcp/shared";
import type { ToolPolicy } from "@/lib/pi/tool-infos";
import { MCP_POLICY_OPTIONS, MCP_POLICY_LABELS, mcpPolicyHint } from "./mcp-policy";

/**
 * A row's columns under a server's name: what it is, then its policy.
 *
 * The width lives here so the server's own policy and every tool's sit in one
 * column, flush with the right edge the rest of the page's controls use.
 */
export const MCP_POLICY_COLUMNS = "grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3";

/** A server's tool list, as the rows need it. */
export type McpToolsState =
  | { kind: "loading" }
  /** The server has not been reached yet, so its tool names are unknown. */
  | { kind: "unknown"; error: string | null }
  | { kind: "known"; tools: McpToolSummary[] }
  | { kind: "failed"; error: string };

/**
 * One policy control, in the column every other one shares.
 *
 * The trigger names what is stored, so a tool that follows its server says so
 * instead of repeating the server's policy.
 */
function McpPolicySelect({
  stored,
  label,
  onChange,
  followServer = false,
  disabled = false,
}: {
  /** The stored answer: a policy, or `clear` for a tool that follows its server. */
  stored: string;
  label: string;
  onChange: (value: string) => void;
  followServer?: boolean;
  disabled?: boolean;
}) {
  return (
    <Select
      value={stored}
      disabled={disabled}
      onValueChange={(next: string | null) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger className="w-36 shrink-0 text-xs" aria-label={label}>
        <SelectValue>{() => MCP_POLICY_LABELS[stored] ?? "Ask"}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {MCP_POLICY_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
        {followServer && <SelectItem value="clear">Follow server</SelectItem>}
      </SelectContent>
    </Select>
  );
}

/**
 * The MCP servers of a tool category, with the approval policy of each one and
 * of every tool it contributes.
 *
 * A server's policy is the default for its tools; a tool's own policy wins over
 * it, which is the order the approval gate resolves. Names are asked for only
 * when a server is opened: a catalogue costs a connection to the server.
 */
export function McpApprovalRows({
  servers,
  toolPolicies,
  onServerPolicyChange,
  onToolPolicyChange,
  onScopeChange,
  loadTools,
  probeServer,
}: {
  servers: McpServer[];
  /** The user's per-tool policies, keyed by the name the model calls. */
  toolPolicies: Record<string, ToolPolicy>;
  onServerPolicyChange: (server: McpServer, policy: McpToolPolicy) => void;
  /** A tool's own policy, or null to let the server's decide again. */
  onToolPolicyChange: (toolName: string, policy: ToolPolicy | null) => void;
  onScopeChange: (
    server: McpServer,
    patch: { chatEnabled?: boolean; coderEnabled?: boolean },
  ) => void;
  loadTools: (id: string) => Promise<McpToolSummary[] | null>;
  /** Connect to the server and list its tools, which also caches the names. */
  probeServer: (server: McpServer) => Promise<void>;
}) {
  const [tools, setTools] = useState<Record<string, McpToolsState>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [probing, setProbing] = useState<string | null>(null);

  const readTools = useCallback(
    async (server: McpServer) => {
      setTools((current) => ({ ...current, [server.id]: { kind: "loading" } }));
      try {
        const found = await loadTools(server.id);
        setTools((current) => ({
          ...current,
          [server.id]: found ? { kind: "known", tools: found } : { kind: "unknown", error: null },
        }));
      } catch (err) {
        console.error(`Failed to read the tools of MCP server "${server.name}":`, err);
        setTools((current) => ({
          ...current,
          [server.id]: { kind: "failed", error: (err as Error).message },
        }));
      }
    },
    [loadTools],
  );

  const toggle = (server: McpServer) => {
    const next = !open[server.id];
    setOpen((current) => ({ ...current, [server.id]: next }));
    if (next && !tools[server.id]) void readTools(server);
  };

  const probe = async (server: McpServer) => {
    setProbing(server.id);
    try {
      await probeServer(server);
      await readTools(server);
    } catch (err) {
      console.error(`Failed to list the tools of MCP server "${server.name}":`, err);
      setTools((current) => ({
        ...current,
        [server.id]: { kind: "failed", error: (err as Error).message },
      }));
    } finally {
      setProbing(null);
    }
  };

  return (
    <div className="space-y-3">
      {servers.map((server) => {
        const state = tools[server.id];
        const expanded = Boolean(open[server.id]);
        return (
          <div key={server.id}>
            {/* One line with the scopes, so the Chat and Coder columns of the page hold. */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">{server.name}</span>
                  {server.shared && (
                    <Badge variant="outline" className="shrink-0">
                      Shared
                    </Badge>
                  )}
                  {!server.enabled && <span className="text-muted-foreground text-xs"> - off</span>}
                </div>
                {server.description && (
                  <p className="text-muted-foreground text-xs">{server.description}</p>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <ScopeSwitches
                  label={server.name}
                  chat={server.chatEnabled}
                  coder={server.coderEnabled}
                  disabled={!server.enabled || server.shared}
                  onChatChange={(checked) => onScopeChange(server, { chatEnabled: checked })}
                  onCoderChange={(checked) => onScopeChange(server, { coderEnabled: checked })}
                />
                {/* A shared server is the instance's, and its tools are listed for
                    the admin; nothing here can reach them. */}
                {!server.shared && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`${expanded ? "Hide" : "Show"} the tools of ${server.name}`}
                    aria-expanded={expanded}
                    onClick={() => toggle(server)}
                  >
                    {expanded ? <ChevronDown /> : <ChevronRight />}
                  </Button>
                )}
              </div>
            </div>

            {/* Everything below shares one column, so the selects line up. */}
            <div className="mt-1 space-y-1.5">
              <div className={MCP_POLICY_COLUMNS}>
                <div className="min-w-0">
                  <p className="text-xs">Approval</p>
                  <p className="text-muted-foreground text-[11px]">
                    {server.shared ? "Set by the instance" : mcpPolicyHint(server.toolPolicy)}
                  </p>
                </div>
                <McpPolicySelect
                  stored={server.toolPolicy}
                  label={`Approval for ${server.name}`}
                  disabled={server.shared}
                  onChange={(value) => onServerPolicyChange(server, value as McpToolPolicy)}
                />
              </div>

              {expanded && (
                <McpToolPolicyRows
                  state={state ?? { kind: "loading" }}
                  toolPolicies={toolPolicies}
                  probing={probing === server.id}
                  onProbe={() => void probe(server)}
                  onToolPolicyChange={onToolPolicyChange}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The tools of one server with their own policies.
 *
 * Each row carries what the tool does, cut to one line with the full text on
 * hover. A tool without a policy of its own says "Follow server" in the select,
 * which is also how it is put back under the server's.
 */
export function McpToolPolicyRows({
  state,
  toolPolicies,
  probing,
  onProbe,
  onToolPolicyChange,
}: {
  state: McpToolsState;
  toolPolicies: Record<string, ToolPolicy>;
  probing: boolean;
  onProbe: () => void;
  onToolPolicyChange: (toolName: string, policy: ToolPolicy | null) => void;
}) {
  if (state.kind === "loading" || probing) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 py-1 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {probing ? "Asking the server for its tools…" : "Reading the tools…"}
      </p>
    );
  }

  if (state.kind === "failed") {
    return <p className="text-destructive text-xs break-words">{state.error}</p>;
  }

  if (state.kind === "unknown" || state.tools.length === 0) {
    return (
      <div className="space-y-1.5">
        {state.kind === "unknown" && state.error && (
          <p className="text-destructive text-xs break-words">{state.error}</p>
        )}
        <p className="text-muted-foreground text-xs">
          {state.kind === "known"
            ? "This server answered with no tools."
            : "Its tools are listed once the server is reachable."}
        </p>
        <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={onProbe}>
          <Wrench className="mr-1.5 h-3.5 w-3.5" />
          Find tools
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {state.tools.map((tool) => {
        // A stored value that is not an MCP policy (an older "auto") leaves the
        // gate on the server's policy, so the row follows the server.
        const own = toolPolicies[tool.name];
        return (
          <div key={tool.name} className={MCP_POLICY_COLUMNS}>
            <span className="min-w-0">
              <span className="block font-mono text-xs break-all">{tool.label}</span>
              {tool.description ? (
                <Tooltip>
                  <TooltipTrigger className="text-muted-foreground focus-visible:outline-ring block w-full truncate rounded-sm text-left text-xs focus-visible:outline-1">
                    {tool.description}
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[min(24rem,calc(100vw-2rem))] break-words">
                    {tool.description}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </span>
            <McpPolicySelect
              stored={isMcpToolPolicy(own) ? own : "clear"}
              label={`Approval for ${tool.label}`}
              followServer
              onChange={(next) =>
                onToolPolicyChange(tool.name, next === "clear" ? null : (next as ToolPolicy))
              }
            />
          </div>
        );
      })}
    </div>
  );
}
