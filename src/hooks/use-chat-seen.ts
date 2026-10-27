"use client";

import { useCallback, useEffect } from "react";

/**
 * Report that this chat is on screen, so a finished reply is not pushed to the
 * user's other devices (see `src/lib/notifications/chat-finished.ts`).
 *
 * Reports are event-driven: on mount, when the tab comes back to the front, and
 * whatever moment the caller calls `reportSeen` — the chat calls it when a turn
 * finishes. Nothing repeats, and a hidden tab reports nothing.
 */
export function useChatSeen(sessionId: string): () => void {
  const reportSeen = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    void fetch(`/api/chat/sessions/${sessionId}/seen`, { method: "POST" }).catch((err) => {
      console.error(`Failed to report chat ${sessionId} as seen:`, err);
    });
  }, [sessionId]);

  useEffect(() => {
    reportSeen();
    document.addEventListener("visibilitychange", reportSeen);
    return () => document.removeEventListener("visibilitychange", reportSeen);
  }, [reportSeen]);

  return reportSeen;
}
