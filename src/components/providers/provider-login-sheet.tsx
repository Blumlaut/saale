"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";

import { CopyButton } from "@/components/chat/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { ProviderAuthType, ProviderLoginState } from "@/lib/providers/login";

/**
 * Signing in to a provider, rendered from what Pi's flow asks for.
 *
 * Pi owns the whole conversation: it decides which values to prompt for, which
 * URL to open, which device code to show. This renders the current step and
 * posts the answer back, so a provider Pi gains needs nothing here.
 */

/** How often the sheet asks what the flow is waiting for next. */
const POLL_INTERVAL_MS = 1_000;

export interface ProviderLoginTarget {
  providerId: string;
  providerName: string;
  authType: ProviderAuthType;
}

interface ProviderLoginSheetProps {
  /** The provider to connect; `null` closes the sheet. */
  target: ProviderLoginTarget | null;
  /** Route that starts, polls and cancels a sign-in. */
  loginEndpoint: string;
  /** Route that answers the current step. */
  answerEndpoint: string;
  onClose: () => void;
  /** Called once when the sign-in succeeds, so the caller can reload models. */
  onConnected: () => void;
}

export function ProviderLoginSheet({
  target,
  loginEndpoint,
  answerEndpoint,
  onClose,
  onConnected,
}: ProviderLoginSheetProps) {
  const [loginId, setLoginId] = useState<string | null>(null);
  const [state, setState] = useState<ProviderLoginState | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The step the user is being shown, so an answer cannot race past it. */
  const promptSeq = state?.prompt?.seq ?? null;
  const notifiedConnected = useRef(false);

  const pending = state?.status === "pending";

  // Start a sign-in whenever a new provider is opened.
  useEffect(() => {
    if (!target) {
      setLoginId(null);
      setState(null);
      setError(null);
      return;
    }

    notifiedConnected.current = false;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(loginEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: target.providerId, authType: target.authType }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
        if (cancelled) return;

        setLoginId(body.id);
        setState(body.state ?? null);
      } catch (err) {
        console.error("Failed to start the provider sign-in:", err);
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to start the sign-in");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [target, loginEndpoint]);

  // Follow the flow while it runs.
  useEffect(() => {
    if (!loginId || !pending) return;

    let cancelled = false;
    const poll = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`${loginEndpoint}?id=${encodeURIComponent(loginId)}`);
          const body = await response.json();
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
          if (!cancelled) setState(body.state);
        } catch (err) {
          // A sign-in that expires mid-poll stops being followed; the sheet
          // keeps whatever it last showed rather than flashing an error.
          console.error("Failed to read the provider sign-in state:", err);
          if (!cancelled)
            setError(err instanceof Error ? err.message : "Lost track of the sign-in");
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [loginId, pending, loginEndpoint]);

  // A fresh step means the previous answer belongs to a question already past.
  useEffect(() => {
    setAnswer("");
  }, [promptSeq]);

  useEffect(() => {
    if (state?.status === "succeeded" && !notifiedConnected.current) {
      notifiedConnected.current = true;
      onConnected();
    }
  }, [state?.status, onConnected]);

  const handleClose = useCallback(() => {
    if (loginId && pending) {
      // The flow keeps running server-side otherwise, holding a port until it
      // times out. Cancelling is the caller's intent when the sheet is closed.
      void fetch(`${loginEndpoint}?id=${encodeURIComponent(loginId)}`, { method: "DELETE" }).catch(
        (err) => {
          console.error("Failed to cancel the provider sign-in:", err);
        },
      );
    }
    onClose();
  }, [loginId, pending, loginEndpoint, onClose]);

  const submitAnswer = async (value: string) => {
    const step = state?.prompt;
    if (!loginId || !step) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(answerEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: loginId, seq: step.seq, value }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
      setState(body.state);
    } catch (err) {
      console.error("Failed to answer the provider sign-in:", err);
      setError(err instanceof Error ? err.message : "Failed to answer the sign-in");
    }
    setBusy(false);
  };

  const prompt = state?.prompt ?? null;
  const isSelect = prompt?.kind === "select";

  return (
    <Sheet open={target !== null} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b px-4 pt-6 pb-4 md:px-6">
            <SheetTitle className="text-lg leading-tight font-semibold tracking-tight">
              Connect {target?.providerName ?? ""}
            </SheetTitle>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 md:px-6">
            {(state?.events ?? [])
              .filter((event) => event.kind !== "progress" || event.message)
              .map((event, index) => (
                <div key={`${event.kind}-${index}`} className="space-y-2">
                  {event.kind === "auth_url" && event.url && (
                    <div className="space-y-2">
                      <div className="liquid-glass-inner flex items-start gap-2 rounded-lg px-3 py-2">
                        <code className="min-w-0 flex-1 text-[11px] break-all">{event.url}</code>
                        <CopyButton text={event.url} label="Copy the sign-in URL" />
                      </div>
                      <Button size="sm" variant="secondary" asChild>
                        <a href={event.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-3.5 w-3.5" />
                          Open sign-in page
                        </a>
                      </Button>
                    </div>
                  )}

                  {event.kind === "device_code" && (
                    <div className="liquid-glass-inner space-y-2 rounded-lg px-3 py-3">
                      <p className="text-muted-foreground text-xs">
                        Enter this code in the browser:
                      </p>
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-base font-semibold tracking-widest">
                          {event.userCode}
                        </code>
                        {event.userCode && (
                          <CopyButton text={event.userCode} label="Copy the device code" />
                        )}
                      </div>
                      {event.verificationUri && (
                        <a
                          href={event.verificationUri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary block text-xs break-all underline-offset-4 hover:underline"
                        >
                          {event.verificationUri}
                        </a>
                      )}
                      {event.expiresInSeconds ? (
                        <p className="text-muted-foreground text-[11px]">
                          Expires in {Math.round(event.expiresInSeconds / 60)} minutes.
                        </p>
                      ) : null}
                    </div>
                  )}

                  {event.kind === "info" && (
                    <div className="space-y-1">
                      <p className="text-sm">{event.message}</p>
                      {event.links?.map((link) => (
                        <a
                          key={link.url}
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary block text-xs break-all underline-offset-4 hover:underline"
                        >
                          {link.label ?? link.url}
                        </a>
                      ))}
                    </div>
                  )}

                  {event.kind === "progress" && event.message && (
                    <p className="text-muted-foreground text-xs">{event.message}</p>
                  )}
                </div>
              ))}

            {prompt && (
              <div className="space-y-2">
                <Label className="text-sm">{prompt.message}</Label>
                {isSelect ? (
                  <div className="space-y-2">
                    {prompt.options?.map((option) => (
                      <Button
                        key={option.id}
                        variant="secondary"
                        className="h-auto w-full flex-col items-start gap-1 py-2.5 text-left whitespace-normal"
                        disabled={busy}
                        // A choice is the answer. no separate submit.
                        onClick={() => void submitAnswer(option.id)}
                      >
                        <span className="text-sm font-medium">{option.label}</span>
                        {option.description && (
                          <span className="text-muted-foreground text-xs font-normal">
                            {option.description}
                          </span>
                        )}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <Input
                      value={answer}
                      type={prompt.kind === "secret" ? "password" : "text"}
                      placeholder={prompt.placeholder ?? ""}
                      onChange={(event) => setAnswer(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && answer) void submitAnswer(answer);
                      }}
                      className="h-9 text-xs"
                      autoComplete="off"
                    />
                    <Button
                      size="sm"
                      onClick={() => void submitAnswer(answer)}
                      disabled={busy || !answer}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Submit"}
                    </Button>
                  </div>
                )}
                {prompt.kind === "manual_code" && (
                  <p className="text-muted-foreground text-[11px]">
                    Paste the final address from your browser. the page may not load, the code is in
                    the address bar.
                  </p>
                )}
              </div>
            )}

            {state?.status === "succeeded" && (
              <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> Connected.
              </p>
            )}

            {pending && !prompt && (state?.events.length ?? 0) === 0 && (
              <p className="flex items-center gap-1.5 text-xs">
                <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" /> Starting…
              </p>
            )}

            {(error || state?.error) && (
              <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="break-words">{error ?? state?.error}</span>
              </p>
            )}
          </div>

          <div className="border-t px-4 py-4 md:px-6">
            {state?.status === "succeeded" ? (
              <Button className="h-9 w-full text-xs font-medium" onClick={handleClose}>
                Done
              </Button>
            ) : (
              <Button
                variant="secondary"
                className="h-9 w-full text-xs font-medium"
                onClick={handleClose}
              >
                {pending ? "Cancel sign-in" : "Close"}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
