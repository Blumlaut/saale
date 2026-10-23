"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Loader2, MessageSquarePlus, MoreVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deleteJson } from "@/lib/http";
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
  const { project, chats, loading, error, reload } = useProject(projectId);
  const [deleting, setDeleting] = useState<CoderProjectChat | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (chat: CoderProjectChat) => {
    setBusy(true);
    setDeleteError(null);
    try {
      await deleteJson(`/api/chat/sessions/${encodeURIComponent(chat.id)}`);
      setDeleting(null);
      reload();
      if (chat.id === activeSessionId) router.push(`/dashboard/coder/${projectId}`);
    } catch (err) {
      console.error(`Failed to delete coder chat ${chat.id}:`, err);
      // git's refusal is the answer, and it names what is in the way.
      setDeleteError(err instanceof Error ? err.message : "Could not delete this chat.");
    } finally {
      setBusy(false);
    }
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
          onClick={onNewChat}
          disabled={!project}
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="text-destructive p-3 text-sm break-words">{error}</p>}

        {!error && !loading && chats.length === 0 && (
          <p className="text-muted-foreground p-3 text-sm">
            No chats yet. Start one and it gets its own worktree.
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
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      setDeleting(chat);
                      setDeleteError(null);
                    }}
                  >
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

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              Its worktree is removed first. git refuses a checkout with uncommitted work, and then
              nothing is deleted.
              {deleting?.worktree && (
                <>
                  {" "}
                  Branch <span className="font-mono break-all">
                    {deleting.worktree.branch}
                  </span>{" "}
                  stays in the repo.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p className="text-destructive text-sm break-words whitespace-pre-wrap">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) void remove(deleting);
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </GlassPanel>
  );
}
