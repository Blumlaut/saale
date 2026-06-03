"use client";

import { useState, useEffect, useCallback } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { fetchJson, postJson } from "@/lib/http";
import { splitEmailAddresses } from "@/lib/email/utils";
import { toast } from "sonner";
import type { EmailAccount } from "@/types/shared";
import { EmailComposeForm } from "@/components/mail/email-compose-form";

interface ComposeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ComposeSheet({ open, onOpenChange }: ComposeSheetProps) {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [accountId, setAccountId] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchJson<{ accounts: EmailAccount[] }>("/api/email/accounts");
      const accs = data.accounts ?? [];
      setAccounts(accs);
      if (accs.length > 0 && !accountId) {
        setAccountId(accs[0]!.id);
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
      await postJson(`/api/email/accounts/${accountId}/send`, {
        to: splitEmailAddresses(to),
        cc: splitEmailAddresses(cc),
        bcc: splitEmailAddresses(bcc),
        subject,
        body,
      });

      toast.success("Email sent");
      resetAndClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="liquid-glass flex w-full flex-col overflow-hidden border-0 bg-transparent p-0 shadow-2xl sm:w-[560px] sm:max-w-none">
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
        />
      </SheetContent>
    </Sheet>
  );
}
