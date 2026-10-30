"use client";

import { AlertTriangle } from "lucide-react";
import { formatProviderError } from "@/lib/pi/provider-error";

/**
 * Provider error notice for a failed assistant turn.
 *
 * Rendered instead of (or below) the turn's text when the provider call itself
 * failed. the case where a chat would otherwise show an empty bubble and no
 * explanation. The raw error is what's persisted; this makes it readable
 * without hiding anything: when the message is a shortening of the raw text,
 * the original follows in muted type.
 */
export function ProviderErrorNotice({ error }: { error: string }) {
  const { status, message, shortened } = formatProviderError(error);

  return (
    <div className="border-destructive/30 bg-destructive/5 rounded-2xl border px-4 py-3">
      <div className="text-destructive flex items-center gap-2 text-xs font-medium">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>Provider error</span>
        {status !== undefined && (
          <span className="border-destructive/30 rounded px-1.5 py-0.5 text-[10px] tabular-nums">
            {status}
          </span>
        )}
      </div>
      <p className="text-foreground/90 mt-1.5 text-sm break-words whitespace-pre-wrap">{message}</p>
      {shortened && (
        <p className="text-muted-foreground/70 mt-1 font-mono text-[11px] break-words whitespace-pre-wrap">
          {error}
        </p>
      )}
    </div>
  );
}
