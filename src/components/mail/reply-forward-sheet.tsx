"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Send, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { parseAddresses } from "@/lib/email/utils";
import { EmailComposeForm } from "@/components/mail/email-compose-form";
import { useEmailCompose } from "@/hooks/use-email-compose";

interface ReplyForwardSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "reply" | "reply_all" | "forward";
  originalMessage: {
    id: string;
    fromName: string | null;
    fromEmail: string;
    to: unknown;
    subject: string;
    bodyText: string | null;
    bodyPreview: string | null;
    accountId: string;
  } | null;
  onSuccess: () => void;
}

export function ReplyForwardSheet({
  open,
  onOpenChange,
  mode,
  originalMessage,
  onSuccess,
}: ReplyForwardSheetProps) {
  const { formProps, loadAccounts, reset, send, setTo, setSubject, setBody, setError } =
    useEmailCompose({ preferredAccountId: originalMessage?.accountId });
  const [generating, setGenerating] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Pre-fill fields when dialog opens or message changes
  useEffect(() => {
    if (!open || !originalMessage) return;

    const { fromName, fromEmail, to: toRaw, subject: origSubject } = originalMessage;
    const senderName = fromName || fromEmail;
    const senderEmail = fromEmail;
    const toAddresses = parseAddresses(toRaw);

    if (mode === "reply") {
      setTo(`${senderName} <${senderEmail}>`);
      setSubject(origSubject.startsWith("Re: ") ? origSubject : `Re: ${origSubject}`);
    } else if (mode === "reply_all") {
      const allRecipients = [...new Set([`${senderName} <${senderEmail}>`, ...toAddresses])];
      setTo(allRecipients.join(", "));
      setSubject(origSubject.startsWith("Re: ") ? origSubject : `Re: ${origSubject}`);
    } else if (mode === "forward") {
      setTo("");
      setSubject(origSubject.startsWith("Fwd: ") ? origSubject : `Fwd: ${origSubject}`);
    }

    const originalBody = originalMessage.bodyText || originalMessage.bodyPreview || "";
    if (mode === "forward") {
      setBody(
        `---------- Forwarded message ---------\nFrom: ${senderName} <${senderEmail}>\nSubject: ${origSubject}\n\n${originalBody}`,
      );
    } else {
      const quotedLines = originalBody
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      setBody(`\n\n${quotedLines}`);
    }

    setTimeout(() => bodyRef.current?.focus(), 100);
  }, [open, originalMessage, mode, setTo, setSubject, setBody]);

  useEffect(() => {
    if (open) void loadAccounts();
  }, [open, loadAccounts]);

  const close = () => {
    reset();
    onOpenChange(false);
  };

  const handleSend = async () => {
    const outcome = await send();
    if (!outcome.ok) {
      if (outcome.error) toast.error(outcome.error);
      return;
    }
    close();
    onSuccess();
  };

  const handleGenerateDraft = async () => {
    if (!originalMessage?.id) return;

    setGenerating(true);
    setError("");

    try {
      const res = await fetch("/api/email/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: originalMessage.id,
          mode,
        }),
      });

      if (!res.ok) {
        throw new Error(`Failed to generate draft (status ${res.status})`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let draftText = "";
      // The stream ends even when drafting fails, so the error is delivered in
      // the payload rather than as a transport failure.
      let streamError = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.error) {
                  streamError = String(data.error);
                } else if (data.text) {
                  draftText = data.text;
                  setBody(draftText);
                }
              } catch (err) {
                console.error("Malformed draft stream event:", err);
              }
            }
          }
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }
      if (!draftText.trim()) {
        throw new Error("The model returned an empty draft");
      }

      toast.success("Draft generated");
    } catch (err) {
      const errorMsg = (err as Error).message;
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setGenerating(false);
    }
  };

  const modeLabel = mode === "reply" ? "Reply" : mode === "reply_all" ? "Reply All" : "Forward";

  const bodyHeader = (
    <div className="flex items-center justify-between">
      <Label className="text-xs">Body</Label>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-xs"
        onClick={handleGenerateDraft}
        disabled={generating || !originalMessage}
      >
        {generating ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Sparkles className="h-3 w-3" />
        )}
        {generating ? "Generating..." : "AI Draft"}
      </Button>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[560px] sm:max-w-none">
        <EmailComposeForm
          {...formProps}
          onSend={handleSend}
          onDiscard={close}
          bodyRef={bodyRef}
          bodyHeader={bodyHeader}
          bodyClassName="min-h-[250px] resize-y rounded-2xl border-0 bg-muted/50 font-mono text-sm shadow-none"
          headerContent={
            <>
              <Send className="h-4 w-4" />
              {modeLabel}
            </>
          }
        />
      </SheetContent>
    </Sheet>
  );
}
