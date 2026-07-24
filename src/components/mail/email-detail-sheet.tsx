"use client";

import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { getTagColor } from "@/lib/email/tags";
import { parseAddresses } from "@/lib/email/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChevronLeft, Loader2 } from "lucide-react";
import { MessageToolbar } from "./message-toolbar";
import type { EmailMessageDetail } from "./types";

function getSender(msg: EmailMessageDetail): string {
  if (msg.fromName) return msg.fromName;
  if (msg.fromEmail) return msg.fromEmail;
  return "Unknown Sender";
}

interface EmailDetailSheetProps {
  open: boolean;
  onClose: () => void;
  message: EmailMessageDetail | null;
  loadingMessage: boolean;
  onRemoveTag: (msgId: string, tag: string) => void;
  onRefresh: () => void;
}

export function EmailDetailSheet({
  open,
  onClose,
  message,
  loadingMessage,
  onRemoveTag,
  onRefresh,
}: EmailDetailSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0">
        <div className="flex h-full flex-col">
          {/* Header */}
          <SheetHeader className="border-border/30 flex items-center justify-between border-b px-4 pt-5 pb-3">
            <Button variant="ghost" size="icon" className="-ml-2 h-7 w-7" onClick={onClose}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <SheetTitle className="truncate text-sm font-medium">
              {message?.subject || "Email"}
            </SheetTitle>
            <div className="w-7" />
          </SheetHeader>

          {loadingMessage ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : (
            message && (
              <>
                {/* Toolbar row */}
                <div className="border-border/30 flex items-center gap-1 overflow-x-auto border-b px-4 py-2">
                  <MessageToolbar message={message} onRefresh={onRefresh} />
                </div>

                <div className="flex-1 overflow-y-auto px-4">
                  {/* Sender info */}
                  <div className="py-3">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{getSender(message)}</span>
                      <span className="text-muted-foreground text-xs">
                        &lt;{message.fromEmail}&gt;
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      To: {parseAddresses(message.to).join(", ")}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {format(new Date(message.date), "MMM d, yyyy 'at' h:mm a")}
                    </p>
                  </div>

                  {/* Tags */}
                  {message.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 py-2">
                      {message.tags.map((tag) => (
                        <Badge
                          key={tag}
                          className={cn(
                            "cursor-pointer rounded-full px-2 py-0.5 text-xs",
                            getTagColor(tag),
                          )}
                          onClick={() => onRemoveTag(message.id, tag)}
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Message body */}
                  <div className="pb-4">
                    {message.bodyHtml ? (
                      <div
                        className="max-w-none"
                        dangerouslySetInnerHTML={{ __html: message.bodyHtml }}
                      />
                    ) : (
                      <pre className="text-sm whitespace-pre-wrap">
                        {message.bodyText || message.bodyPreview}
                      </pre>
                    )}
                  </div>
                </div>
              </>
            )
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
