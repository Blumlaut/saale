"use client";

import { useState, useEffect, useCallback } from "react";
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
import { Send } from "lucide-react";

interface EmailAccount {
  id: string;
  email: string;
  enabled: boolean;
}

interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ComposeDialog({ open, onOpenChange }: ComposeDialogProps) {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [accountId, setAccountId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/email/accounts");
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts);
        if (data.accounts.length > 0 && !accountId) {
          setAccountId(data.accounts[0].id);
        }
      }
    } catch {
      // Ignore
    }
  }, [accountId]);

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
      const res = await fetch(`/api/email/accounts/${accountId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          subject,
          body,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to send");
      }

      // Reset and close
      setTo("");
      setSubject("");
      setBody("");
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    setTo("");
    setSubject("");
    setBody("");
    setError("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4" />
            Compose Email
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* From */}
          <div className="space-y-2">
            <Label>From</Label>
            <Select value={accountId} onValueChange={(v) => v && setAccountId(v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select account" />
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
          <div className="space-y-2">
            <Label>To</Label>
            <Input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
            />
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <Label>Subject</Label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
            />
          </div>

          {/* Body */}
          <div className="space-y-2">
            <Label>Body</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              className="min-h-[200px]"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={handleClose}>
              Discard
            </Button>
            <Button onClick={handleSend} disabled={sending || !to.trim() || !accountId}>
              {sending ? (
                <>Sending...</>
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
