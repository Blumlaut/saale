"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { patchJson } from "@/lib/http";
import { ReplyForwardSheet } from "./reply-forward-sheet";
import { toast } from "sonner";
import {
  Reply,
  ReplyAll,
  Forward,
  MoreHorizontal,
  Archive,
  Trash2,
  Star,
  Eye,
  EyeOff,
} from "lucide-react";
import type { EmailMessage } from "./types";

/** Shared toolbar for desktop detail and mobile sheet */
export function MessageToolbar({
  message,
  onRefresh,
}: {
  message: EmailMessage;
  onRefresh: () => void;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply_all" | "forward">("reply");

  const openReply = (mode: "reply" | "reply_all" | "forward") => {
    setReplyMode(mode);
    setReplyOpen(true);
  };

  const handleTrash = async () => {
    try {
      await patchJson(`/api/email/messages/${message.id}`, { action: "trash" });
      toast.success("Email moved to trash");
      onRefresh();
    } catch {
      toast.error("Failed to trash email");
    }
  };

  const handleArchive = async () => {
    try {
      await patchJson(`/api/email/messages/${message.id}`, { action: "archive" });
      toast.success("Email archived");
      onRefresh();
    } catch {
      toast.error("Failed to archive email");
    }
  };

  const handleToggleRead = async () => {
    try {
      await patchJson(`/api/email/messages/${message.id}`, { isRead: !message.isRead });
      toast.success(message.isRead ? "Marked as unread" : "Marked as read");
      onRefresh();
    } catch {
      toast.error("Failed to update read status");
    }
  };

  const toolbarButtons = (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full text-xs"
        onClick={() => openReply("reply")}
        title="Reply"
      >
        <Reply className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Reply</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full text-xs"
        onClick={() => openReply("reply_all")}
        title="Reply All"
      >
        <ReplyAll className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">All</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full text-xs"
        onClick={() => openReply("forward")}
        title="Forward"
      >
        <Forward className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Forward</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 rounded-full text-xs"
        onClick={handleTrash}
        title="Move to Trash"
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Trash</span>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger>
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors hover:bg-white/10 dark:hover:bg-white/5"
            title="More actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={handleArchive}>
            <Archive className="mr-2 h-4 w-4" />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleToggleRead}>
            {message.isRead ? (
              <>
                <EyeOff className="mr-2 h-4 w-4" />
                Mark Unread
              </>
            ) : (
              <>
                <Eye className="mr-2 h-4 w-4" />
                Mark Read
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={async () => {
              const newStarred = !message.isStarred;
              try {
                await patchJson(`/api/email/messages/${message.id}`, { isStarred: newStarred });
                onRefresh();
              } catch {
                toast.error("Failed to update star");
              }
            }}
          >
            <Star className="mr-2 h-4 w-4" />
            {message.isStarred ? "Unstar" : "Star"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <>
      <div className="flex items-center gap-1">{toolbarButtons}</div>
      <ReplyForwardSheet
        open={replyOpen}
        onOpenChange={setReplyOpen}
        mode={replyMode}
        originalMessage={{
          id: message.id,
          fromName: message.fromName,
          fromEmail: message.fromEmail,
          to: message.to,
          subject: message.subject,
          bodyText: message.bodyText ?? null,
          bodyPreview: message.bodyPreview,
          accountId: message.accountId,
        }}
        onSuccess={onRefresh}
      />
    </>
  );
}
