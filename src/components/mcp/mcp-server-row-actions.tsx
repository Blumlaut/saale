"use client";

import { Loader2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn, ROW_ACTION } from "@/lib/utils";
import type { McpServer } from "@/hooks/use-mcp-servers";

/**
 * The controls beside an MCP server row: on/off, edit, remove.
 *
 * The user's settings panel and the admin's shared-server page render them the
 * same way, so a server is switched off where it is switched on. The user's
 * panel passes none for a shared server, which the account cannot change.
 */
export function McpServerRowActions({
  server,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: McpServer;
  /** A write is in flight, so the switch waits. */
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      {busy ? (
        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
      ) : (
        <Switch
          checked={server.enabled}
          onCheckedChange={onToggle}
          aria-label={`Enable ${server.name}`}
        />
      )}
      <Button
        variant="ghost"
        size="icon"
        className={cn("h-8 w-8", ROW_ACTION)}
        aria-label={`Edit ${server.name}`}
        onClick={onEdit}
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn("text-destructive hover:text-destructive h-8 w-8", ROW_ACTION)}
        aria-label={`Remove ${server.name}`}
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </>
  );
}
