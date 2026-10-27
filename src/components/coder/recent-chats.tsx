"use client";

import { useState } from "react";
import { Bot, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChatListRow } from "@/components/chat/chat-list";
import { deleteChat } from "@/lib/chat/delete-chat";
import { saveChatPin } from "@/lib/chat/pin";
import { formatRelativeDate } from "@/lib/format";
import { DeleteCoderChatDialog } from "./delete-chat-dialog";
import { useRecentChats, type CoderRecentChat } from "./use-coder-data";

/**
 * The coder landing page's recent chats: the last chats used in any project.
 *
 * This is the way back into work. Reaching a chat through its project costs
 * two clicks for a row that is always the same one, so the latest few are here,
 * each opening on its own, with the project under the title to tell two chats
 * with similar names apart.
 */
export function RecentChats() {
  const { chats, hasMore, loading, error, loadMore } = useRecentChats();
  const [deleting, setDeleting] = useState<CoderRecentChat | null>(null);
  // The list re-reads itself on the delete event, so there is nothing to do
  // here but close the box.
  const closeDelete = () => setDeleting(null);

  if (error && chats.length === 0) {
    return <p className="text-destructive px-4 py-3 text-sm break-words">{error}</p>;
  }
  // An empty section would only push the project list down: a new user's empty
  // state is the project list itself, and a first load has nothing to say yet.
  if (chats.length === 0) return null;

  return (
    <section>
      <div className="border-border/30 flex items-center gap-2 border-b px-4 py-2">
        <span className="console-label min-w-0 truncate">Recent chats</span>
      </div>

      {chats.map((chat, index) => (
        <div key={chat.id}>
          <ChatListRow
            title={chat.title || "New Chat"}
            href={`/dashboard/coder/${chat.project.id}/${chat.id}`}
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
                <span className="max-w-[45%] shrink-0 truncate">{chat.project.name}</span>
                <span className="shrink-0">{formatRelativeDate(chat.lastActivityAt)}</span>
                {chat.worktree && (
                  <span className="truncate text-[11px]">{chat.worktree.branch}</span>
                )}
              </>
            }
            onTogglePin={() =>
              saveChatPin(chat.id, !chat.pinned).catch((err: unknown) => {
                console.error(
                  `Failed to ${chat.pinned ? "unpin" : "pin"} coder chat ${chat.id}:`,
                  err,
                );
              })
            }
            onDelete={() => setDeleting(chat)}
          />
          {(index < chats.length - 1 || hasMore) && <Separator />}
        </div>
      ))}

      {hasMore && (
        <div className="flex justify-center p-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground w-full"
            onClick={loadMore}
            disabled={loading}
          >
            {loading && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Show more chats
          </Button>
        </div>
      )}

      <DeleteCoderChatDialog
        chat={deleting}
        onCancel={closeDelete}
        onDelete={async (chat, force) => {
          try {
            await deleteChat(chat.id, force);
          } catch (err) {
            console.error(`Failed to delete coder chat ${chat.id}:`, err);
            throw err;
          }
        }}
      />
    </section>
  );
}
