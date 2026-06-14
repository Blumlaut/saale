"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Send, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { fetchJson, postJson } from "@/lib/http";
import { parseAddresses, splitEmailAddresses } from "@/lib/email/utils";
import type { EmailAccount } from "@/types/shared";
import { EmailComposeForm } from "@/components/mail/email-compose-form";

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
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [accountId, setAccountId] = useState("");
  const [sending, setSending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchJson<{ accounts: EmailAccount[] }>("/api/email/accounts");
      const accs = data.accounts ?? [];
      setAccounts(accs);
      if (accs.length > 0 && !accountId) {
        const preferAccount = originalMessage?.accountId
          ? accs.find((a) => a.id === originalMessage.accountId)
          : undefined;
        setAccountId(preferAccount?.id ?? accs[0]!.id);
      }
    } catch {
      // Ignore
    }
  }, [accountId, originalMessage]);

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
  }, [open, originalMessage, mode]);

  useEffect(() => {
    if (open) {
      loadAccounts();
    }
  }, [open, loadAccounts]);

  const handleSend = async () => {
    if (!to.trim() || !accountId) return;

    setSending(true);
    setError("");

    try {
      await postJson(`/api/email/accounts/${accountId}/send`, {
        to: splitEmailAddresses(to),
        cc: splitEmailAddresses(cc),
        bcc: splitEmailAddresses(bcc),
        subject,
        body,
      });

      toast.success("Email sent");
      resetAndClose();
      onSuccess();
    } catch (err) {
      const errorMsg = (err as Error).message;
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setSending(false);
    }
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
                if (data.text) {
                  draftText = data.text;
                  setBody(draftText);
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        }
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

  const resetAndClose = () => {
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setBody("");
    setError("");
    onOpenChange(false);
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
          accounts={accounts}
          accountId={accountId}
          onAccountIdChange={setAccountId}
          to={to}
          onToChange={setTo}
          cc={cc}
          onCcChange={setCc}
          bcc={bcc}
          onBccChange={setBcc}
          subject={subject}
          onSubjectChange={setSubject}
          body={body}
          onBodyChange={setBody}
          error={error}
          sending={sending}
          onSend={handleSend}
          onDiscard={resetAndClose}
          bodyRef={bodyRef}
          bodyHeader={bodyHeader}
          bodyClassName="min-h-[250px] resize-y rounded-2xl border-0 bg-white/5 font-mono text-sm shadow-none"
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
