"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, ChevronLeft, Loader2, MessageSquarePlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Separator } from "@/components/ui/separator";
import { ChatListRow, PinnedChatGroup } from "@/components/chat/chat-list";
import { deleteChat } from "@/lib/chat/delete-chat";
import { saveChatPin } from "@/lib/chat/pin";
import { splitPinnedSessions } from "@/lib/chat/session-recency";
import { formatRelativeDate } from "@/lib/format";
import { DeleteCoderChatDialog } from "./delete-chat-dialog";
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
      await deleteChat(chat.id, force);
    } catch (err) {
      console.error(`Failed to delete coder chat ${chat.id}:`, err);
      throw err;
    }
    reload();
    if (chat.id === activeSessionId) router.push(`/dashboard/coder/${projectId}`);
  };

  // The list re-reads itself on the pin event, so the row moves once the
  // server has it, the same way a chat started here shows up.
  const togglePin = async (chat: CoderProjectChat) => {
    try {
      await saveChatPin(chat.id, !chat.pinned);
    } catch (err) {
      console.error(`Failed to ${chat.pinned ? "unpin" : "pin"} coder chat ${chat.id}:`, err);
      toast.error(chat.pinned ? "Could not unpin the chat" : "Could not pin the chat");
    }
  };

  const { pinned, unpinned } = useMemo(() => splitPinnedSessions(chats), [chats]);

  const renderRows = (list: readonly CoderProjectChat[]) =>
    list.map((chat, index) => (
      <div key={chat.id}>
        <ChatListRow
          title={chat.title || "New Chat"}
          href={`/dashboard/coder/${projectId}/${chat.id}`}
          active={chat.id === activeSessionId}
          pinned={chat.pinned}
          accessories={
            <>
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
            </>
          }
          subtitle={
            <>
              <span className="shrink-0">{formatRelativeDate(chat.lastActivityAt)}</span>
              {chat.worktree && (
                <span className="truncate text-[11px]">{chat.worktree.branch}</span>
              )}
            </>
          }
          onTogglePin={() => togglePin(chat)}
          onDelete={() => setDeleting(chat)}
        />
        {index < list.length - 1 && <Separator />}
      </div>
    ));

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
            className="h-9 w-full justify-center gap-2 rounded-lg"
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

        <PinnedChatGroup pinned={pinned} renderRows={renderRows} hasRest={unpinned.length > 0}>
          {renderRows(unpinned)}
        </PinnedChatGroup>
      </div>

      <DeleteCoderChatDialog chat={deleting} onCancel={() => setDeleting(null)} onDelete={remove} />
    </GlassPanel>
  );
}
