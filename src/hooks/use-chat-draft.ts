"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadDraft, saveDraft } from "@/lib/chat/draft";

/**
 * Per-session composer draft, persisted to localStorage.
 *
 * The stored draft is read in an effect (not during render) — the server
 * renders an empty composer, so hydrating from storage while rendering would
 * mismatch. Writes are debounced to keep keystrokes off localStorage's
 * synchronous path, with an unmount flush so navigating away mid-word never
 * loses the last characters.
 *
 * Two rules keep the stored draft safe:
 *  - Nothing is written until the draft has been read for the *current*
 *    session, so a switch (or React's StrictMode mount/unmount/mount) can
 *    never write an empty or stale value over the stored text.
 *  - The unmount flush writes the session and value that were current at the
 *    time, not whatever the hook is being switched to.
 *
 * Storage is read only when the session changes (opening a chat), never while
 * a draft is being edited. Watching `storage` events here would let a second
 * tab on the same chat replace the text mid-sentence.
 */

const SAVE_DEBOUNCE_MS = 400;

export function useChatDraft(sessionId: string) {
  const [draft, setDraft] = useState("");
  /** Session whose stored draft the current `draft` value was loaded for. */
  const [loadedForSession, setLoadedForSession] = useState<string | null>(null);

  // Load (and re-load when the session changes). This is the only point at
  // which a draft written elsewhere is adopted.
  useEffect(() => {
    setDraft(loadDraft(sessionId));
    setLoadedForSession(sessionId);
  }, [sessionId]);

  // Snapshot for the unmount flush: the flush runs on session change and on
  // unmount, both of which happen before the next render's effects.
  const latestRef = useRef({ sessionId, draft, loaded: false });
  useEffect(() => {
    latestRef.current = { sessionId, draft, loaded: loadedForSession === sessionId };
  }, [sessionId, draft, loadedForSession]);

  useEffect(() => {
    if (loadedForSession !== sessionId) return;
    const timer = setTimeout(() => saveDraft(sessionId, draft), SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, draft, loadedForSession]);

  useEffect(() => {
    return () => {
      const latest = latestRef.current;
      if (!latest.loaded) return;
      saveDraft(latest.sessionId, latest.draft);
    };
  }, [sessionId]);

  const updateDraft = useCallback((text: string) => setDraft(text), []);

  return { draft, setDraft: updateDraft };
}
