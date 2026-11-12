"use client";

import { Loader2, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { McpServer } from "@/hooks/use-mcp-servers";

/**
 * The controls beside an MCP server row: the switch that turns it on, and a menu
 * for everything else.
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(triggerProps) => (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              aria-label={`Actions for ${server.name}`}
              {...triggerProps}
            >
              <MoreVertical />
            </Button>
          )}
        />
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
