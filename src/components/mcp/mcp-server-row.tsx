"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { McpServer } from "@/hooks/use-mcp-servers";

/** How a server's tool calls are approved, as the row names it. */
export const MCP_POLICY_LABELS: Record<string, string> = {
  ask: "Ask",
  allow: "Allow",
  off: "Blocked",
};

/** Where a server connects, or null when that is both scopes. */
function scopeLabel(server: McpServer): string | null {
  if (server.chatEnabled && server.coderEnabled) return null;
  if (server.chatEnabled) return "Chat only";
  if (server.coderEnabled) return "Coder only";
  return "Nowhere";
}

/**
 * One MCP server in a list: what it is on the left, its controls on the right.
 *
 * The user's settings panel and the admin's shared-server page render the same
 * row, so a server reads the same in both. A shared server carries no actions
 * in the user's panel: the account cannot edit what the instance wrote.
 */
export function McpServerRow({ server, actions }: { server: McpServer; actions?: ReactNode }) {
  return (
    <div className="group flex flex-wrap items-center gap-3 px-4 py-3 transition-colors duration-150 md:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{server.name}</span>
          {server.shared && (
            <Badge variant="outline" className="shrink-0">
              Shared
            </Badge>
          )}
          <Badge variant="secondary" className="shrink-0">
            {MCP_POLICY_LABELS[server.toolPolicy] ?? "Ask"}
          </Badge>
          {server.hasToken && (
            <Badge variant="outline" className="shrink-0">
              Token
            </Badge>
          )}
          {server.hasOAuth && (
            <Badge variant="outline" className="shrink-0">
              OAuth
            </Badge>
          )}
          {server.enabled && scopeLabel(server) && (
            <Badge variant="outline" className="shrink-0">
              {scopeLabel(server)}
            </Badge>
          )}
          {!server.enabled && (
            <Badge variant="outline" className="shrink-0">
              Disabled
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-xs break-all">{server.url}</p>
        {server.description && (
          <p className="text-muted-foreground mt-0.5 text-xs">{server.description}</p>
        )}
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
