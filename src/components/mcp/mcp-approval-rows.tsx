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
import type { McpServer, McpToolSummary } from "@/hooks/use-mcp-servers";
import type { McpToolPolicy } from "@/lib/mcp/shared";
import type { ToolPolicy } from "@/lib/pi/tool-infos";
import { MCP_POLICY_OPTIONS, MCP_POLICY_LABELS, mcpPolicyHint } from "./mcp-policy";

/** A server's tool list, as the rows need it. */
type ToolsState =
  | { kind: "loading" }
  /** The server has not been reached yet, so its tool names are unknown. */
  | { kind: "unknown"; error: string | null }
  | { kind: "known"; tools: McpToolSummary[] }
  | { kind: "failed"; error: string };

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
  const [tools, setTools] = useState<Record<string, ToolsState>>({});
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
    <div className="space-y-1.5">
      {servers.map((server) => {
        const state = tools[server.id];
        const expanded = Boolean(open[server.id]);
        return (
          <div key={server.id}>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1 basis-full sm:basis-0">
                <span className="text-sm">{server.name}</span>
                {server.shared && (
                  <Badge variant="outline" className="ml-2 shrink-0">
                    Shared
                  </Badge>
                )}
                {!server.enabled && <span className="text-muted-foreground text-xs"> - off</span>}
                {server.description && (
                  <p className="text-muted-foreground text-xs">{server.description}</p>
                )}
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <ScopeSwitches
                  label={server.name}
                  chat={server.chatEnabled}
                  coder={server.coderEnabled}
                  disabled={!server.enabled || server.shared}
                  onChatChange={(checked) => onScopeChange(server, { chatEnabled: checked })}
                  onCoderChange={(checked) => onScopeChange(server, { coderEnabled: checked })}
                />
                <Select
                  value={server.toolPolicy}
                  onValueChange={(value) => {
                    if (value) onServerPolicyChange(server, value as McpToolPolicy);
                  }}
                >
                  <SelectTrigger
                    className="w-24 shrink-0"
                    aria-label={`Approval for ${server.name}`}
                  >
                    <SelectValue>
                      {(value) => MCP_POLICY_LABELS[value as string] ?? "Ask"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    {MCP_POLICY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              </div>
            </div>

            {expanded && (
              <div className="border-border/60 mt-1.5 space-y-1.5 border-l pl-3">
                <p className="text-muted-foreground text-xs">{mcpPolicyHint(server.toolPolicy)}</p>
                <ToolRows
                  server={server}
                  state={state ?? { kind: "loading" }}
                  toolPolicies={toolPolicies}
                  probing={probing === server.id}
                  onProbe={() => void probe(server)}
                  onToolPolicyChange={onToolPolicyChange}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The tools of one server, or what it takes to learn them. */
function ToolRows({
  server,
  state,
  toolPolicies,
  probing,
  onProbe,
  onToolPolicyChange,
}: {
  server: McpServer;
  state: ToolsState;
  toolPolicies: Record<string, ToolPolicy>;
  probing: boolean;
  onProbe: () => void;
  onToolPolicyChange: (toolName: string, policy: ToolPolicy | null) => void;
}) {
  if (state.kind === "loading" || probing) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-xs">
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
        const own = toolPolicies[tool.name];
        const policy = own ?? server.toolPolicy;
        return (
          <div key={tool.name} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="font-mono text-xs break-all">{tool.label}</span>
              <span className="text-muted-foreground text-xs">
                {own ? " - its own policy" : " - follows the server"}
              </span>
            </div>
            <Select
              value={own ? policy : "clear"}
              onValueChange={(value: string | null) => {
                if (value === "clear") onToolPolicyChange(tool.name, null);
                else if (value) onToolPolicyChange(tool.name, value as ToolPolicy);
              }}
            >
              <SelectTrigger className="w-24 shrink-0" aria-label={`Approval for ${tool.label}`}>
                {/* The row names what will happen, which is the server's policy until it has its own. */}
                <SelectValue>{() => MCP_POLICY_LABELS[policy] ?? "Ask"}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                {MCP_POLICY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
                <SelectItem value="clear">Follow server</SelectItem>
              </SelectContent>
            </Select>
          </div>
        );
      })}
    </div>
  );
}
