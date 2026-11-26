"use client";

import { AlertTriangle } from "lucide-react";

/**
 * A line the app wrote into a conversation, for work that happened without a
 * model turn and went wrong: an automation whose fire never arrived.
 *
 * It sits in the transcript like a turn, so the failure is where the user would
 * have read the report.
 */
export function ChatNotice({ text }: { text: string }) {
  return (
    <div className="border-destructive/30 bg-destructive/5 flex items-start gap-2 rounded-lg border px-3 py-2">
      <AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
      <p className="text-foreground/90 min-w-0 text-sm break-words whitespace-pre-wrap">{text}</p>
    </div>
  );
}
