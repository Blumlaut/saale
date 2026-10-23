"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PROVISIONING_STEP_COPY } from "./provisioning-copy";
import { useProvisioning } from "./use-coder-data";

/** How often the elapsed time under the card re-renders. */
const TICK_MS = 1_000;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * The chat's card for a workspace that is being built.
 *
 * A coder chat makes its worktree, writes the project's env files and runs its
 * setup script before the agent sees the first message, and an install takes
 * minutes. Without this the chat is a spinner with nothing behind it, which
 * reads as broken. Rendered above the composer, like the send-queue strip, so
 * it is visible wherever the transcript is scrolled.
 */
export function ProvisioningNotice({
  sessionId,
  waiting,
}: {
  sessionId: string;
  waiting: boolean;
}) {
  const provisioning = useProvisioning(sessionId, waiting);
  const startedAt = provisioning?.startedAt ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!provisioning) return null;

  const copy = PROVISIONING_STEP_COPY[provisioning.step];
  const elapsed = formatElapsed(now - Date.parse(provisioning.startedAt));

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-border/30 bg-muted/30 mb-2 rounded-none border px-3 py-2 md:rounded-2xl"
    >
      <div className="flex items-start gap-2">
        <Loader2 className="text-muted-foreground mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="console-label">Setting up the workspace</span>
            <span className="console-label ml-auto shrink-0 tabular-nums">{elapsed}</span>
          </div>
          <p className="mt-1 text-xs font-medium break-words md:text-sm">{copy.label}</p>
          <p className="text-muted-foreground text-xs break-words">{copy.detail}</p>
        </div>
      </div>
    </div>
  );
}
