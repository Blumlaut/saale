"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Send, Sparkles, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { fetchJson, postJson } from "@/lib/http";
import { parseAddresses, splitEmailAddresses } from "@/lib/email/utils";
import type { EmailAccount } from "@/types/shared";

interface ReplyForwardDialogProps {
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

export function ReplyForwardDialog({
  open,
  onOpenChange,
  mode,
  originalMessage,
  onSuccess,
}: ReplyForwardDialogProps) {
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
      const accounts = data.accounts ?? [];
      setAccounts(accounts);
      if (accounts.length > 0 && !accountId) {
        const preferAccount = originalMessage?.accountId
          ? accounts.find((a) => a.id === originalMessage.accountId)
          : undefined;
        setAccountId(preferAccount?.id ?? accounts[0]!.id);
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
      // Reply to sender + all recipients except self
      const allRecipients = [...new Set([`${senderName} <${senderEmail}>`, ...toAddresses])];
      setTo(allRecipients.join(", "));
      setSubject(origSubject.startsWith("Re: ") ? origSubject : `Re: ${origSubject}`);
    } else if (mode === "forward") {
      setTo("");
      setSubject(origSubject.startsWith("Fwd: ") ? origSubject : `Fwd: ${origSubject}`);
    }

    // Build body with quoted original
    const originalBody = originalMessage.bodyText || originalMessage.bodyPreview || "";
    if (mode === "forward") {
      setBody(
        `---------- Forwarded message ---------\nFrom: ${senderName} <${senderEmail}>\nSubject: ${origSubject}\n\n${originalBody}`,
      );
    } else {
      // Put quoted text at the bottom
      const quotedLines = originalBody
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      setBody(`\n\n${quotedLines}`);
    }

    // Focus the body after a tick
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

      // Read SSE stream
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
            if (line.startsWith("event: token")) {
              // Next line is data
            } else if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.text) {
                  draftText = data.text;
                  // Stream into the body (replace everything before quoted text)
                  setBody(draftText);
                }
              } catch {
                // Skip malformed JSON
              }
            } else if (line.startsWith("event: done")) {
              // Done
            }
          }
        }
      }

      // Position cursor at the start of the body for editing
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

  const handleClose = () => {
    resetAndClose();
  };

  const modeLabel = mode === "reply" ? "Reply" : mode === "reply_all" ? "Reply All" : "Forward";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            {modeLabel}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* From */}
          <div className="space-y-1.5">
            <Label className="text-xs">From</Label>
            <Select value={accountId} onValueChange={(v) => v && setAccountId(v)}>
              <SelectTrigger className="h-8">
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
              className="h-8"
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
              {/* CC */}
              <div className="space-y-1.5">
                <Label className="text-xs">Cc</Label>
                <Input
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                  placeholder="cc@example.com"
                  className="h-8"
                />
              </div>

              {/* BCC */}
              <div className="space-y-1.5">
                <Label className="text-xs">Bcc</Label>
                <Input
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                  placeholder="bcc@example.com"
                  className="h-8"
                />
              </div>
              <Separator />
            </>
          )}

          {/* Subject */}
          <div className="space-y-1.5">
            <Label className="text-xs">Subject</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
              className="h-8"
            />
          </div>

          {/* Body with AI Draft button */}
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
              className="min-h-[250px] font-mono text-sm"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={handleClose}>
              Discard
            </Button>
            <Button onClick={handleSend} disabled={sending || !to.trim() || !accountId}>
              {sending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Send
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
