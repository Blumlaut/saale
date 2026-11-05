"use client";

import { useState } from "react";
import { Loader2, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Page, PageAction, PageActions, PageScroll } from "@/components/layout/page";
import { cn, ROW_ACTION } from "@/lib/utils";
import { useAdminCollection } from "@/hooks/use-admin-collection";
import type { McpServer, McpServerInput } from "@/hooks/use-mcp-servers";
import { McpServerRow } from "@/components/mcp/mcp-server-row";
import { McpServerSheet } from "@/components/mcp/mcp-server-sheet";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

/**
 * The MCP servers every account connects.
 *
 * A shared server is stored once for the instance, so an admin adds it here
 * rather than on every account. A user's own server of the same name replaces
 * it for that user.
 *
 * A shared server signs in with its stored token: OAuth belongs to one account,
 * which is why this form has no sign-in block.
 */
export function SharedMcpServersSection() {
  const {
    items: servers,
    loading,
    create,
    update,
    remove,
  } = useAdminCollection<McpServer>({
    url: "/api/admin/shared-mcp-servers",
    key: "servers",
  });

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpServer | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const save = async (input: McpServerInput) => {
    if (editing) return update(editing.id, input);
    return create(input);
  };

  const toggle = async (server: McpServer, enabled: boolean) => {
    setBusyId(server.id);
    try {
      await update(server.id, { enabled });
    } catch (err) {
      console.error("Failed to toggle the shared MCP server:", err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Page className="gap-0">
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <PageActions>
          <PageAction
            icon={Plus}
            label="Add server"
            onClick={() => {
              setEditing(null);
              setSheetOpen(true);
            }}
          />
        </PageActions>

        <PageScroll>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : servers.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-16 text-center md:px-6">
              <Plug className="text-muted-foreground/50 h-8 w-8" />
              <p className="text-muted-foreground mt-3 max-w-md text-sm">
                No shared servers yet. Add one, and every account connects it in the chats it is
                switched on for.
              </p>
            </div>
          ) : (
            <div>
              {servers.map((server, index) => (
                <div key={server.id}>
                  {index > 0 && <Separator />}
                  <McpServerRow
                    server={server}
                    actions={
                      <>
                        {busyId === server.id ? (
                          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                        ) : (
                          <Switch
                            checked={server.enabled}
                            onCheckedChange={(checked) => void toggle(server, checked)}
                            aria-label={`Enable ${server.name}`}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("h-8 w-8", ROW_ACTION)}
                          aria-label={`Edit ${server.name}`}
                          onClick={() => {
                            setEditing(server);
                            setSheetOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "text-destructive hover:text-destructive h-8 w-8",
                            ROW_ACTION,
                          )}
                          aria-label={`Delete ${server.name}`}
                          onClick={() => setPendingDelete(server)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </PageScroll>
      </GlassPanel>

      <McpServerSheet open={sheetOpen} onOpenChange={setSheetOpen} server={editing} onSave={save} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.name ?? "this server"}?`}
        description="Every account loses this server's tools in its next message. A user's own server of the same name keeps working."
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await remove(pendingDelete.id);
        }}
      />
    </Page>
  );
}
