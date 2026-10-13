"use client";

import { useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Loader2, Pencil, Plug, Plus, Trash2 } from "lucide-react";
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
import { McpServerSheet } from "../components/mcp-server-sheet";

const POLICY_LABELS: Record<string, string> = {
  ask: "Ask",
  allow: "Allow",
  off: "Blocked",
};

/**
 * Settings → MCP. Servers configured here connect to every agent session the
 * user starts, so a configured server "just works" in chat, Telegram and jobs.
 */
export function McpTab() {
  const {
    servers,
    loading,
    updateServer,
    deleteServer,
    createServer,
    testServer,
    startOAuth,
    readOAuthStatus,
    signOutOAuth,
    loadServers,
  } = useMcpServers();

  const [sheetOpen, setSheetOpen] = useState(false);
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
                Connect Model Context Protocol servers. Their tools are available in every
                conversation, so connecting a server is all it takes.
              </p>
            </div>
            <Button size="sm" className="shrink-0" aria-label="Add server" onClick={openAdd}>
              <Plus className="h-4 w-4 md:mr-2" />
              <span className="hidden md:inline">Add server</span>
            </Button>
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
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3 transition-colors duration-150 md:px-6">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{server.name}</span>
                        <Badge variant="secondary" className="shrink-0">
                          {POLICY_LABELS[server.toolPolicy] ?? "Ask"}
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

                    <div className="flex shrink-0 items-center gap-1">
                      {busyId === server.id ? (
                        <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                      ) : (
                        <Switch
                          checked={server.enabled}
                          onCheckedChange={(checked) => void handleToggle(server, checked)}
                          aria-label={`Enable ${server.name}`}
                        />
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`Edit ${server.name}`}
                        onClick={() => openEdit(server)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive h-8 w-8"
                        aria-label={`Remove ${server.name}`}
                        onClick={() => setPendingDelete(server)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
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
        onTest={testServer}
        onStartOAuth={startOAuth}
        onOAuthStatus={readOAuthStatus}
        onSignOutOAuth={signOutOAuth}
      />

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
