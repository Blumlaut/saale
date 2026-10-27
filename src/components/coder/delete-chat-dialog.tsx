"use client";

import { ForceDeleteDialog } from "@/components/shared/force-delete-dialog";
import type { CoderProjectChat } from "./use-coder-data";

/**
 * The confirmation a coder chat row opens when it is deleted.
 *
 * The project's chat list and the landing page's recent chats both delete a
 * chat that owns a checkout, so the warning is written once here.
 */
export function DeleteCoderChatDialog({
  chat,
  onCancel,
  onDelete,
}: {
  chat: CoderProjectChat | null;
  onCancel: () => void;
  onDelete: (chat: CoderProjectChat, force: boolean) => Promise<void>;
}) {
  return (
    <ForceDeleteDialog
      open={chat !== null}
      onOpenChange={(open) => !open && onCancel()}
      title="Delete this chat?"
      description="This will delete all data in this worktree."
      discard="this chat's uncommitted changes"
      onDelete={(force) => (chat ? onDelete(chat, force) : Promise.resolve())}
    />
  );
}
