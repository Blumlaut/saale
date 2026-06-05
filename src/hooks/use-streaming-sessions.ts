"use client";

import { useEffect, useState, useCallback, useRef } from "react";

const STORAGE_KEY_STREAMING = "chat-streaming-sessions";
const STORAGE_KEY_FINISHED = "chat-finished-sessions";
const FINISH_TIMEOUT = 650; // ms — matches pop-dot animation duration

function getStreamingSessions(): Set<string> {
  try {
    const data = localStorage.getItem(STORAGE_KEY_STREAMING);
    if (!data) return new Set();
    const parsed = JSON.parse(data) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function writeStreamingSessions(sessions: Set<string>) {
  localStorage.setItem(STORAGE_KEY_STREAMING, JSON.stringify([...sessions]));
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
  const [streamingIds, setStreamingIds] = useState<Set<string>>(getStreamingSessions);
  const [finishedIds, setFinishedIds] = useState<Set<string>>(getFinishedSessions);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const markStreaming = useCallback((sessionId: string) => {
    // Clear any pending finish timer
    const timer = timersRef.current.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(sessionId);
    }
    // Clear finished state
    setFinishedIds((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      writeFinishedSessions(next);
      return next;
    });
    setStreamingIds((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      writeStreamingSessions(next);
      return next;
    });
  }, []);

  const markDone = useCallback((sessionId: string) => {
    // Remove from streaming
    setStreamingIds((prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      writeStreamingSessions(next);
      return next;
    });
    // Add to finished (triggers pop animation)
    setFinishedIds((prev) => {
      const next = new Set(prev);
      next.add(sessionId);
      writeFinishedSessions(next);
      return next;
    });
    // Clear after animation completes
    const timer = setTimeout(() => {
      setFinishedIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        writeFinishedSessions(next);
        return next;
      });
      timersRef.current.delete(sessionId);
    }, FINISH_TIMEOUT);
    timersRef.current.set(sessionId, timer);
  }, []);

  // Cleanup timers on unmount
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  // Sync from other tabs via localStorage events
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_STREAMING) {
        setStreamingIds(getStreamingSessions());
      } else if (e.key === STORAGE_KEY_FINISHED) {
        setFinishedIds(getFinishedSessions());
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return { streamingIds, finishedIds, markStreaming, markDone };
}
