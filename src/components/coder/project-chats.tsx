"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bot, ChevronLeft, Loader2, MessageSquarePlus, MoreVertical, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ForceDeleteDialog } from "@/components/shared/force-delete-dialog";
import { deleteJson } from "@/lib/http";
import { broadcastSessionsDeleted } from "@/lib/chat/session-events";
import { formatRelativeDate } from "@/lib/format";
import { ROW_ACTION, cn } from "@/lib/utils";
import { useProject, type CoderProjectChat } from "./use-coder-data";

/**
 * A project's chats, and the way back to the project list.
 *
 * The branch sits under a row once the chat has a worktree, so two chats in one
 * project are told apart by the work they are doing rather than by title alone.
 */
export function ProjectChats({
  projectId,
  activeSessionId,
  onNewChat,
}: {
  projectId: string;
  activeSessionId?: string;
  onNewChat?: () => void;
}) {
  const router = useRouter();
  const { project, chats, loading, error, reload } = useProject(projectId, activeSessionId ?? null);
  const [deleting, setDeleting] = useState<CoderProjectChat | null>(null);

  const remove = async (chat: CoderProjectChat, force: boolean) => {
    try {
      await deleteJson(
        `/api/chat/sessions/${encodeURIComponent(chat.id)}${force ? "?force=1" : ""}`,
      );
    } catch (err) {
      console.error(`Failed to delete coder chat ${chat.id}:`, err);
      throw err;
    }
    // The chat list's other copy (desktop panel, phone sheet) and the main
    // sidebar all still show the row.
    broadcastSessionsDeleted([chat.id]);
    reload();
    if (chat.id === activeSessionId) router.push(`/dashboard/coder/${projectId}`);
  };

  return (
    <GlassPanel className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="All projects"
          onClick={() => router.push("/dashboard/coder")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{project?.name ?? "Project"}</p>
          <p className="text-muted-foreground truncate text-xs">
            {project ? `${project.slug} · ${project.defaultBranch}` : ""}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New coder chat"
          className="hidden md:inline-flex"
          onClick={onNewChat}
          disabled={!project}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>

      {/* Full-width on phones, mirroring the chat sidebar: the header icon is
          too easy to miss at the corner of the panel. */}
      {onNewChat && (
        <div className="border-border/30 border-b p-2 md:hidden">
          <Button
            className="liquid-glass-accent h-9 w-full justify-center gap-2 rounded-lg"
            onClick={onNewChat}
            disabled={!project}
          >
            <MessageSquarePlus className="h-4 w-4" />
            New coder chat
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="text-destructive p-3 text-sm break-words">{error}</p>}

        {!error && !loading && chats.length === 0 && (
          <p className="text-muted-foreground flex h-full items-center justify-center p-3 text-center text-sm">
            No chats yet.
          </p>
        )}

        {chats.map((chat, index) => (
          <div key={chat.id}>
            <div
              className={cn(
                "group hover:bg-accent/60 flex items-center gap-1 px-1 transition-colors",
                chat.id === activeSessionId && "bg-accent",
              )}
            >
              <Link
                href={`/dashboard/coder/${projectId}/${chat.id}`}
                className="flex min-w-0 flex-1 flex-col gap-0.5 py-2.5 pl-2"
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {chat.title || "New Chat"}
                  </span>
                  {/* Opened by a watcher fire rather than by a person. */}
                  {chat.origin === "watcher" && (
                    <Badge variant="secondary" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">
                      <Bot className="h-3 w-3" />
                      Bot
                    </Badge>
                  )}
                  {chat.isGenerating && (
                    <Loader2 className="text-primary h-3 w-3 shrink-0 animate-spin" />
                  )}
                </span>
                <span className="text-muted-foreground flex items-center gap-2 text-xs">
                  <span className="shrink-0">{formatRelativeDate(chat.lastActivityAt)}</span>
                  {chat.worktree && (
                    <span className="truncate font-mono text-[11px]">{chat.worktree.branch}</span>
                  )}
                </span>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(triggerProps) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className={cn("shrink-0", ROW_ACTION)}
                      aria-label={`Actions for ${chat.title || "this chat"}`}
                      {...triggerProps}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  )}
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(chat)}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete chat
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {index < chats.length - 1 && <Separator />}
          </div>
        ))}
      </div>

      <ForceDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this chat?"
        description="This will delete all data in this worktree."
        discard="this chat's uncommitted changes"
        onDelete={(force) => (deleting ? remove(deleting, force) : Promise.resolve())}
      />
    </GlassPanel>
  );
}
