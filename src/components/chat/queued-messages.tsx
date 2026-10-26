"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ArrowUp, Clock, Loader2, Paperclip, Pencil, X } from "lucide-react";
import { stripAttachmentPromptText } from "@/lib/strip-attachment-prompt";
import { isSendKey } from "@/lib/chat/enter-to-send";
import type { Message } from "./types";

/**
 * Send queue strip. messages submitted while Pi is still working.
 *
 * They are not part of the conversation yet: the server delivers them when the
 * current run finishes (or immediately, when the user pushes one). Each entry
 * can be sent now, edited, or cancelled.
 */
export function QueuedMessages({
  messages,
  sendingId,
  paused,
  onEdit,
  onSendNow,
  onCancel,
}: {
  messages: Message[];
  /** Message whose "send now" request is in flight. */
  sendingId?: string | null;
  /** Generation stopped. these wait for the user (send now, or a new message). */
  paused?: boolean;
  onEdit: (messageId: string, content: string) => Promise<void>;
  onSendNow: (messageId: string) => Promise<void>;
  onCancel: (messageId: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  if (messages.length === 0) return null;

  const startEditing = (message: Message) => {
    setEditingId(message.id);
    setEditValue(message.content);
  };

  const submitEdit = async (messageId: string) => {
    const content = editValue.trim();
    if (!content) return;
    await onEdit(messageId, content);
    setEditingId(null);
  };

  return (
    <div
      role="group"
      aria-label="Queued messages"
      className="border-border/30 bg-muted/30 mb-2 rounded-none border px-2 py-1.5 md:rounded-2xl"
    >
      <div className="text-muted-foreground flex items-center gap-1.5 px-1.5 py-1">
        <Clock className="h-3 w-3" />
        <span className="console-label">
          Queued · {messages.length}
          {paused ? " · paused" : ""}
        </span>
        <span className="ml-auto hidden text-[11px] sm:inline">
          {paused
            ? "Paused. send now, or send a new message"
            : "Sent when the current response finishes"}
        </span>
      </div>

      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {messages.map((message, index) => (
          <div key={message.id} className="hover:bg-accent/40 rounded-xl px-1.5 py-1">
            {editingId === message.id ? (
              <div className="space-y-1.5">
                <Textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (isSendKey(e)) {
                      e.preventDefault();
                      void submitEdit(message.id);
                    } else if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  rows={2}
                  autoFocus
                  aria-label="Edit queued message"
                  className="max-h-40 min-h-[44px] resize-none text-xs"
                />
                <div className="flex justify-end gap-1.5">
                  <Button variant="ghost" size="xs" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    onClick={() => void submitEdit(message.id)}
                    disabled={!editValue.trim()}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground w-3 shrink-0 text-center font-mono text-[11px] tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-xs"
                    title={
                      message.attachments?.length
                        ? stripAttachmentPromptText(message.content)
                        : message.content
                    }
                  >
                    {message.attachments?.length
                      ? stripAttachmentPromptText(message.content)
                      : message.content}
                  </p>
                  {message.attachments && message.attachments.length > 0 && (
                    <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
                      <Paperclip className="h-3 w-3" />
                      {message.attachments.length} file
                      {message.attachments.length > 1 ? "s" : ""}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void onSendNow(message.id)}
                    disabled={sendingId === message.id}
                    aria-label="Send this message now"
                    title="Send now. before the current run finishes"
                  >
                    {sendingId === message.id ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => startEditing(message)}
                    aria-label="Edit queued message"
                    title="Edit"
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void onCancel(message.id)}
                    aria-label="Cancel queued message"
                    title="Cancel"
                  >
                    <X />
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
