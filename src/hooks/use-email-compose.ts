"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";

import { fetchJson, postJson } from "@/lib/http";
import { splitEmailAddresses } from "@/lib/email/utils";
import type { EmailComposeForm } from "@/components/mail/email-compose-form";
import type { EmailAccount } from "@/types/shared";

/** The draft fields and their handlers, ready to spread into `EmailComposeForm`. */
type DraftFormProps = Omit<
  Parameters<typeof EmailComposeForm>[0],
  "onSend" | "onDiscard" | "bodyRef" | "bodyHeader" | "bodyClassName" | "headerContent"
>;

/** What a send did, or why it did nothing. */
export type SendOutcome = { ok: true } | { ok: false; error: string | null };

/**
 * The draft a compose or reply sheet sends: its fields, the account it sends
 * from, and the request.
 */
export function useEmailCompose(options?: { preferredAccountId?: string | null | undefined }) {
  const preferredAccountId = options?.preferredAccountId ?? null;

  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchJson<{ accounts: EmailAccount[] }>("/api/email/accounts");
      const loaded = data.accounts ?? [];
      setAccounts(loaded);
      setAccountId((current) => {
        if (current) return current;
        const preferred = preferredAccountId
          ? loaded.find((account) => account.id === preferredAccountId)
          : undefined;
        return preferred?.id ?? loaded[0]?.id ?? "";
      });
    } catch (err) {
      console.error("Failed to load email accounts:", err);
    }
  }, [preferredAccountId]);

  const reset = useCallback(() => {
    setTo("");
    setCc("");
    setBcc("");
    setSubject("");
    setBody("");
    setError("");
  }, []);

  const send = useCallback(async (): Promise<SendOutcome> => {
    if (!to.trim() || !accountId) return { ok: false, error: null };

    setSending(true);
    setError("");

    try {
      const result = await postJson<{ sentFolder: string | null }>(
        `/api/email/accounts/${accountId}/send`,
        {
          to: splitEmailAddresses(to),
          cc: splitEmailAddresses(cc),
          bcc: splitEmailAddresses(bcc),
          subject,
          body,
        },
      );

      if (result.sentFolder) {
        toast.success("Email sent");
      } else {
        toast.warning("Email sent, but no copy could be filed in Sent");
      }
      return { ok: true };
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      return { ok: false, error: message };
    } finally {
      setSending(false);
    }
  }, [accountId, bcc, body, cc, subject, to]);

  const formProps: DraftFormProps = {
    accounts,
    accountId,
    onAccountIdChange: setAccountId,
    to,
    onToChange: setTo,
    cc,
    onCcChange: setCc,
    bcc,
    onBccChange: setBcc,
    subject,
    onSubjectChange: setSubject,
    body,
    onBodyChange: setBody,
    error,
    sending,
  };

  return {
    formProps,
    loadAccounts,
    reset,
    send,
    // The sheets pre-fill a draft, so the setters come out too.
    setTo,
    setSubject,
    setBody,
    setError,
    sending,
  };
}
