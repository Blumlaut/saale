"use client";

import { useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { FileJson, Loader2, Plug, Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMcpServers, type McpServer } from "@/hooks/use-mcp-servers";
import { isCategoryEnabled } from "@/lib/pi/tool-categories";
import { McpServerRow } from "@/components/mcp/mcp-server-row";
import { McpServerRowActions } from "@/components/mcp/mcp-server-row-actions";
import { McpServerSheet } from "@/components/mcp/mcp-server-sheet";
import { McpImportDialog } from "@/components/mcp/mcp-import-dialog";
import { useUserSettings } from "./user-settings-provider";

/**
 * Settings → MCP. A server configured here connects to every agent session the
 * user starts, so it "just works" in chat, Telegram and jobs. The MCP tool
 * category in Settings → Tools decides whether any of them connect.
 */
export function McpPanel() {
  const { settings } = useUserSettings();
  // The MCP category switch decides whether any of these servers connect.
  const paused = settings ? !isCategoryEnabled(settings.defaultToolConfig, "mcp") : false;
  const {
    servers,
    loading,
    updateServer,
    deleteServer,
    createServer,
    importServers,
    testServer,
    startOAuth,
    readOAuthStatus,
    signOutOAuth,
    loadServers,
  } = useMcpServers();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const [pendingDelete, setPendingDelete] = useState<McpServer | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openAdd = () => {
    setEditing(null);
    setSheetOpen(true);
  };

  const openEdit = (server: McpServer) => {
    setEditing(server);
    setSheetOpen(true);
  };

  const handleSave = async (input: Parameters<typeof createServer>[0]) => {
    if (editing) return updateServer(editing.id, input);
    return createServer(input);
  };

  const handleToggle = async (server: McpServer, enabled: boolean) => {
    setBusyId(server.id);
    try {
      await updateServer(server.id, { enabled });
    } catch (err) {
      console.error("Failed to toggle MCP server:", err);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteServer(pendingDelete.id);
    } catch (err) {
      console.error("Failed to delete MCP server:", err);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <>
      <GlassPanel>
        <GlassPanelContent className="p-0">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-5 pb-4 md:px-6">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <Plug className="h-5 w-5" />
                MCP servers
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Connect Model Context Protocol servers. Each one connects in the chats you switch it
                on for, and its tools are available there.
              </p>
              {paused && (
                <p className="text-muted-foreground mt-1 text-sm">
                  Paused: the MCP category is off in Tools, so no server connects.
                </p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                variant="secondary"
                aria-label="Import config"
                onClick={() => setImportOpen(true)}
              >
                <FileJson className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Import</span>
              </Button>
              <Button size="sm" aria-label="Add server" onClick={openAdd}>
                <Plus className="h-4 w-4 md:mr-2" />
                <span className="hidden md:inline">Add server</span>
              </Button>
            </div>
          </div>

          <Separator />

          {servers.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-10 text-center md:px-6">
              <Plug className="text-muted-foreground/50 h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                No MCP servers yet. Add one to extend the assistant with tools from another service.
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
                      // A shared server is the instance's: the account can see it
                      // and use its tools, but not edit or remove it.
                      server.shared ? null : (
                        <McpServerRowActions
                          server={server}
                          busy={busyId === server.id}
                          onToggle={(enabled) => void handleToggle(server, enabled)}
                          onEdit={() => openEdit(server)}
                          onDelete={() => setPendingDelete(server)}
                        />
                      )
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <McpServerSheet
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open);
          // A sign-in completed in the browser changes `hasOAuth`, which the
          // open sheet cannot see; refresh once it closes.
          if (!open) void loadServers();
        }}
        server={editing}
        onSave={handleSave}
        allowStdio
        onTest={testServer}
        onStartOAuth={startOAuth}
        onOAuthStatus={readOAuthStatus}
        onSignOutOAuth={signOutOAuth}
      />

      <McpImportDialog open={importOpen} onOpenChange={setImportOpen} onImport={importServers} />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The assistant will lose this server&apos;s tools in every chat. Any OAuth sign-in or
              stored token for it is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} variant="destructive" disabled={deleting}>
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Removing…
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
