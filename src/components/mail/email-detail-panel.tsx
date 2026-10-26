"use client";

import { cn } from "@/lib/utils";
import { getTagColor } from "@/lib/email/tags";
import { formatMessageDate, parseAddresses, senderLabel } from "@/lib/email/utils";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Mail, Loader2, Plus, X } from "lucide-react";
import { MessageToolbar } from "./message-toolbar";
import { EmailMessageBody } from "./email-message-body";
import type { EmailMessageDetail } from "./types";

interface EmailDetailPanelProps {
  message: EmailMessageDetail | null;
  loadingMessage: boolean;
  allTags: { name: string; count: number }[];
  addingTag: boolean;
  newTagInput: string;
  onToggleAddingTag: (open: boolean) => void;
  onNewTagInputChange: (value: string) => void;
  onAddTag: (msgId: string, tag: string) => void;
  onRemoveTag: (msgId: string, tag: string) => void;
  onRefresh: () => void;
}

export function EmailDetailPanel({
  message,
  loadingMessage,
  allTags,
  addingTag,
  newTagInput,
  onToggleAddingTag,
  onNewTagInputChange,
  onAddTag,
  onRemoveTag,
  onRefresh,
}: EmailDetailPanelProps) {
  return (
    <GlassPanel className="hidden flex-1 flex-col overflow-hidden border-0 md:flex">
      {loadingMessage ? (
        <GlassPanelContent className="flex flex-1 items-center justify-center">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </GlassPanelContent>
      ) : message ? (
        <>
          {/* Detail header with toolbar */}
          <div className="border-border/30 flex flex-col gap-3 border-b px-6 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-lg font-semibold">
                  {message.subject || "(no subject)"}
                </h2>
                <div className="text-muted-foreground mt-1 flex items-center gap-2 text-sm">
                  <span className="truncate font-medium">{senderLabel(message)}</span>
                  <span className="text-muted-foreground/60">&lt;{message.fromEmail}&gt;</span>
                </div>
                <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                  <span>To: {parseAddresses(message.to).join(", ")}</span>
                </div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {formatMessageDate(message.date)}
                </p>
              </div>
              <div className="shrink-0">
                <MessageToolbar message={message} onRefresh={onRefresh} />
              </div>
            </div>
          </div>

          {/* Message tags */}
          <div className="border-border/30 flex items-center gap-1.5 border-b px-6 py-2">
            {message.tags.map((tag) => (
              <Badge
                key={tag}
                className={cn("cursor-pointer rounded-full px-2 py-0.5 text-xs", getTagColor(tag))}
                onClick={() => onRemoveTag(message.id, tag)}
                title={`Remove "${tag}"`}
              >
                {tag}
                <X className="ml-0.5 h-2.5 w-2.5 opacity-50 hover:opacity-100" />
              </Badge>
            ))}
            <Popover open={addingTag} onOpenChange={onToggleAddingTag}>
              <PopoverTrigger>
                <span
                  className="hover:bg-accent/60 inline-flex h-5 w-5 items-center justify-center rounded transition-colors"
                  title="Add tag"
                >
                  <Plus className="h-3 w-3" />
                </span>
              </PopoverTrigger>
              <PopoverContent className="w-56" align="start">
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Add tag</p>
                  <div className="flex gap-1.5">
                    <Input
                      autoFocus
                      value={newTagInput}
                      onChange={(e) => onNewTagInputChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          onAddTag(message.id, newTagInput);
                        }
                        if (e.key === "Escape") {
                          onToggleAddingTag(false);
                          onNewTagInputChange("");
                        }
                      }}
                      placeholder="Tag name"
                      className="h-8"
                    />
                    <Button
                      size="sm"
                      className="h-8"
                      onClick={() => onAddTag(message.id, newTagInput)}
                    >
                      Add
                    </Button>
                  </div>
                  {allTags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {allTags
                        .filter(({ name }) => !message.tags.includes(name))
                        .slice(0, 6)
                        .map(({ name }) => (
                          <button
                            key={name}
                            onClick={() => onAddTag(message.id, name)}
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs transition-colors",
                              getTagColor(name),
                              "hover:opacity-80",
                            )}
                          >
                            + {name}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          {/* Message body */}
          <GlassPanelContent className="flex-1 overflow-y-auto">
            <EmailMessageBody message={message} />
          </GlassPanelContent>
        </>
      ) : (
        <GlassPanelContent className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <Mail className="text-muted-foreground/30 mx-auto mb-3 h-12 w-12" />
            <p className="text-muted-foreground text-sm">Select an email to read</p>
          </div>
        </GlassPanelContent>
      )}
    </GlassPanel>
  );
}
