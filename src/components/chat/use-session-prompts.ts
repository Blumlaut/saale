"use client";

import { useCallback, useState } from "react";
import { fetchJson } from "@/lib/http";
import type { PromptPickerItem } from "@/lib/prompts/resolve";

/**
 * The prompts a chat offers, for the composer's `/` menu.
 *
 * Read when a slash is typed, not on mount: a project's templates are files in
 * the chat's checkout, so the agent's own edits show up without a reload.
 */
export function useSessionPrompts(sessionId: string) {
  const [prompts, setPrompts] = useState<PromptPickerItem[]>([]);

  const refresh = useCallback(() => {
    fetchJson<{ prompts: PromptPickerItem[] }>(`/api/chat/sessions/${sessionId}/prompts`)
      .then((data) => setPrompts(data.prompts ?? []))
      .catch((err: unknown) => {
        console.error(`Failed to load the prompts of chat ${sessionId}:`, err);
      });
  }, [sessionId]);

  return { prompts, refresh };
}
