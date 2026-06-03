"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Send, Sparkles, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fetchJson, postJson } from "@/lib/http";
import { parseAddresses, splitEmailAddresses } from "@/lib/email/utils";
import type { EmailAccount } from "@/types/shared";

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
    bodyPreview: string;
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
  const [showOptions, setShowOptions] = useState(false);
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
    setShowOptions(false);
    onOpenChange(false);
  };

  const modeLabel = mode === "reply" ? "Reply" : mode === "reply_all" ? "Reply All" : "Forward";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="liquid-glass flex w-full flex-col overflow-hidden border-0 bg-transparent p-0 shadow-2xl sm:w-[560px] sm:max-w-none">
        <div className="flex h-full flex-col">
          {/* Header */}
          <SheetHeader className="border-border/30 flex items-center justify-between border-b px-6 pt-6 pb-4">
            <SheetTitle className="flex items-center gap-2 text-xl leading-tight font-semibold tracking-tight">
              <Send className="h-4 w-4" />
              {modeLabel}
            </SheetTitle>
          </SheetHeader>

          {/* Form */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <div className="flex flex-col gap-3">
              {/* From */}
              <div className="space-y-1.5">
                <Label className="text-xs">From</Label>
                <Select value={accountId} onValueChange={(v) => v && setAccountId(v)}>
                  <SelectTrigger className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none">
                    {accounts.find((a) => a.id === accountId)?.email ?? (
                      <SelectValue placeholder="Select account" />
                    )}
                  </SelectTrigger>
                  <SelectContent>
                    {accounts
                      .filter((a) => a.enabled)
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.email}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              {/* To */}
              <div className="space-y-1.5">
                <Label className="text-xs">To</Label>
                <Input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="recipient@example.com"
                  className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
                />
              </div>

              {/* CC / BCC toggle */}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-6 px-2 text-xs"
                onClick={() => setShowOptions(!showOptions)}
              >
                {showOptions ? (
                  <ChevronUp className="mr-1 h-3 w-3" />
                ) : (
                  <ChevronDown className="mr-1 h-3 w-3" />
                )}
                {showOptions ? "Hide" : "Show"} Cc/Bcc
              </Button>

              {showOptions && (
                <>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Cc</Label>
                    <Input
                      value={cc}
                      onChange={(e) => setCc(e.target.value)}
                      placeholder="cc@example.com"
                      className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Bcc</Label>
                    <Input
                      value={bcc}
                      onChange={(e) => setBcc(e.target.value)}
                      placeholder="bcc@example.com"
                      className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
                    />
                  </div>
                  <Separator className="border-border/30" />
                </>
              )}

              {/* Subject */}
              <div className="space-y-1.5">
                <Label className="text-xs">Subject</Label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject"
                  className="liquid-glass-inner h-9 rounded-full border-0 bg-transparent shadow-none"
                />
              </div>

              {/* Body with AI Draft */}
              <div className="space-y-1.5">
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
                <Textarea
                  ref={bodyRef}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write your message..."
                  className="min-h-[250px] resize-y rounded-2xl border-0 bg-white/5 font-mono text-sm shadow-none"
                />
              </div>

              {/* Error */}
              {error && (
                <div className="text-destructive bg-destructive/10 rounded-xl px-4 py-2.5 text-sm">
                  {error}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="border-border/30 border-t px-6 py-4">
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                className="liquid-glass-pill h-9 rounded-full text-xs font-medium"
                onClick={resetAndClose}
              >
                Discard
              </Button>
              <Button
                className="liquid-glass-accent h-9 gap-2 rounded-full text-xs font-medium"
                onClick={handleSend}
                disabled={sending || !to.trim() || !accountId}
              >
                {sending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" /> Send
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
