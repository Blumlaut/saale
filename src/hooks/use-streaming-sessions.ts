"use client";

import { useEffect, useState, useCallback, useRef } from "react";

const STORAGE_KEY_STREAMING = "chat-streaming-sessions";
const STORAGE_KEY_FINISHED = "chat-finished-sessions";
const FINISH_ANIM_TIMEOUT = 650; // ms. matches pop-dot animation duration
const STREAM_STALE_TIMEOUT = 60_000; // ms. auto-clear streaming dot after 60s

interface StreamingEntry {
  id: string;
  startedAt: number;
}

function getStreamingEntries(): Map<string, StreamingEntry> {
  try {
    const data = localStorage.getItem(STORAGE_KEY_STREAMING);
    if (!data) return new Map();
    const parsed = JSON.parse(data) as StreamingEntry[];
    return new Map(parsed.map((e) => [e.id, e]));
  } catch {
    return new Map();
  }
}

function writeStreamingEntries(entries: Map<string, StreamingEntry>) {
  const arr: StreamingEntry[] = [];
  entries.forEach((v) => arr.push(v));
  localStorage.setItem(STORAGE_KEY_STREAMING, JSON.stringify(arr));
}

function getFinishedSessions(): Set<string> {
  try {
    const data = localStorage.getItem(STORAGE_KEY_FINISHED);
    if (!data) return new Set();
    const parsed = JSON.parse(data) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function writeFinishedSessions(sessions: Set<string>) {
  localStorage.setItem(STORAGE_KEY_FINISHED, JSON.stringify([...sessions]));
}

export function useStreamingSessions() {
  const [streamingEntries, setStreamingEntries] =
    useState<Map<string, StreamingEntry>>(getStreamingEntries);
  const [finishedIds, setFinishedIds] = useState<Set<string>>(getFinishedSessions);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Derived: just the session IDs that are streaming
  const streamingIds = new Set(streamingEntries.keys());

  const clearTimer = useCallback((sessionId: string) => {
    const timer = timersRef.current.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(sessionId);
    }
  }, []);

  const markStreaming = useCallback(
    (sessionId: string) => {
      clearTimer(sessionId);
      // Clear finished state
      setFinishedIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        writeFinishedSessions(next);
        return next;
      });
      // Add/update streaming entry with timestamp
      setStreamingEntries((prev) => {
        const next = new Map(prev);
        next.set(sessionId, { id: sessionId, startedAt: Date.now() });
        writeStreamingEntries(next);
        return next;
      });
      // Auto-clear if streaming runs too long (safety net)
      const timer = setTimeout(() => {
        setStreamingEntries((prev) => {
          const next = new Map(prev);
          next.delete(sessionId);
          writeStreamingEntries(next);
          return next;
        });
        timersRef.current.delete(sessionId);
      }, STREAM_STALE_TIMEOUT);
      timersRef.current.set(sessionId, timer);
    },
    [clearTimer],
  );

  const markDone = useCallback(
    (sessionId: string) => {
      clearTimer(sessionId);
      // Remove from streaming
      setStreamingEntries((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        writeStreamingEntries(next);
        return next;
      });
      // Add to finished (triggers pop animation)
      setFinishedIds((prev) => {
        const next = new Set(prev);
        next.add(sessionId);
        writeFinishedSessions(next);
        return next;
      });
      // Clear finished after animation
      const timer = setTimeout(() => {
        setFinishedIds((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          writeFinishedSessions(next);
          return next;
        });
        timersRef.current.delete(sessionId);
      }, FINISH_ANIM_TIMEOUT);
      timersRef.current.set(sessionId, timer);
    },
    [clearTimer],
  );

  // Cleanup timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  // Periodically purge stale streaming entries (safety net for crashed tabs)
  useEffect(() => {
    const interval = setInterval(() => {
      setStreamingEntries((prev) => {
        const now = Date.now();
        let changed = false;
        const next = new Map(prev);
        // Remove entries older than timeout
        for (const [_id, entry] of next) {
          if (now - entry.startedAt > STREAM_STALE_TIMEOUT) {
            next.delete(_id);
            changed = true;
          }
        }
        if (changed) {
          writeStreamingEntries(next);
        }
        return next;
      });
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Sync from other tabs via localStorage events
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_STREAMING) {
        setStreamingEntries(getStreamingEntries());
      } else if (e.key === STORAGE_KEY_FINISHED) {
        setFinishedIds(getFinishedSessions());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return { streamingIds, finishedIds, markStreaming, markDone };
}
