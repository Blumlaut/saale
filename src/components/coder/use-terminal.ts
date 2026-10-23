"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The terminal panel's state: what a command printed, and what is running.
 *
 * One command at a time, like a shell. Output is kept as segments so a build's
 * stdout and stderr can be tinted apart, and it is capped: a dev server prints
 * for as long as it runs, and the panel is not a log file.
 */

/** How much output a panel keeps before it drops the oldest. */
const MAX_OUTPUT_CHARS = 400_000;
/** Lines the up arrow remembers. */
const MAX_HISTORY = 100;

export interface TerminalSegment {
  id: number;
  stream: "stdout" | "stderr" | "note" | "input";
  text: string;
}

export interface TerminalRun {
  execId: string | null;
  command: string;
}

export interface TerminalState {
  segments: TerminalSegment[];
  running: TerminalRun | null;
  /** Set when the last command answered with an error. */
  error: string | null;
  history: string[];
  run: (command: string) => Promise<void>;
  stop: () => void;
  sendInput: (text: string) => Promise<void>;
  clear: () => void;
}

/** Split the frames out of a stream of SSE bytes. */
function parseFrames(buffer: string): {
  frames: Array<{ event: string; data: string }>;
  rest: string;
} {
  const frames: Array<{ event: string; data: string }> = [];
  let rest = buffer;

  for (;;) {
    const boundary = rest.indexOf("\n\n");
    if (boundary === -1) break;
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);

    let event = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (event && data.length > 0) frames.push({ event, data: data.join("\n") });
  }

  return { frames, rest };
}

export function useTerminal(sessionId: string): TerminalState {
  const [segments, setSegments] = useState<TerminalSegment[]>([]);
  const [running, setRunning] = useState<TerminalRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  // Mirrors `running` for the keystroke path, which needs it without waiting
  // for a render.
  const runningRef = useRef<TerminalRun | null>(null);

  const append = useCallback((stream: TerminalSegment["stream"], text: string) => {
    if (!text) return;
    setSegments((current) => {
      const last = current[current.length - 1];
      let next: TerminalSegment[];
      if (last && last.stream === stream) {
        next = [...current.slice(0, -1), { ...last, text: last.text + text }];
      } else {
        next = [...current, { id: nextId.current++, stream, text }];
      }

      // Drop from the front until the panel is back under its cap.
      let total = next.reduce((sum, segment) => sum + segment.text.length, 0);
      while (next.length > 1 && total > MAX_OUTPUT_CHARS) {
        const [first, ...remaining] = next as [TerminalSegment, ...TerminalSegment[]];
        total -= first.text.length;
        next = remaining;
      }
      return next;
    });
  }, []);

  const run = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed || runningRef.current) return;

      setError(null);
      append("input", `$ ${trimmed}\n`);
      setHistory((current) => [...current.slice(-(MAX_HISTORY - 1)), trimmed]);

      const controller = new AbortController();
      abortRef.current = controller;
      const started: TerminalRun = { execId: null, command: trimmed };
      runningRef.current = started;
      setRunning(started);

      try {
        const response = await fetch(`/api/coder/sessions/${sessionId}/terminal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: trimmed }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          const message = await response
            .json()
            .then((body: { error?: string }) => body.error ?? `Command failed (${response.status})`)
            .catch((err: unknown) => {
              console.error("Unreadable terminal error body:", err);
              return `Command failed (${response.status})`;
            });
          setError(message);
          append("note", `${message}\n`);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parsed = parseFrames(buffer);
          buffer = parsed.rest;

          for (const frame of parsed.frames) {
            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(frame.data) as Record<string, unknown>;
            } catch (err) {
              console.error("Malformed terminal frame:", err);
              continue;
            }

            if (frame.event === "started" && typeof payload.execId === "string") {
              const withId: TerminalRun = { execId: payload.execId, command: trimmed };
              runningRef.current = withId;
              setRunning(withId);
            } else if (frame.event === "data" && typeof payload.text === "string") {
              append(payload.stream === "stderr" ? "stderr" : "stdout", payload.text);
            } else if (frame.event === "exit") {
              const code = typeof payload.exitCode === "number" ? payload.exitCode : 1;
              const millis = typeof payload.durationMs === "number" ? payload.durationMs : 0;
              append("note", `exit ${code} · ${(millis / 1000).toFixed(1)}s\n`);
            } else if (frame.event === "error" && typeof payload.message === "string") {
              setError(payload.message);
              append("note", `${payload.message}\n`);
            }
          }
        }
      } catch (err) {
        // An abort is the stop button, not a failure.
        if ((err as Error)?.name !== "AbortError") {
          console.error("Terminal command failed:", err);
          setError(err instanceof Error ? err.message : "Terminal failed");
          append("note", `${err instanceof Error ? err.message : "Terminal failed"}\n`);
        } else {
          append("note", "stopped\n");
        }
      } finally {
        abortRef.current = null;
        runningRef.current = null;
        setRunning(null);
      }
    },
    [append, sessionId],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendInput = useCallback(
    async (text: string) => {
      const execId = runningRef.current?.execId;
      // Nothing is listening before the command announces itself.
      if (!execId || !text) return;

      append("input", text);
      try {
        const response = await fetch(`/api/coder/sessions/${sessionId}/terminal/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ execId, data: text }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          append("note", `${body.error ?? "Input was refused"}\n`);
        }
      } catch (err) {
        console.error("Failed to send terminal input:", err);
        append("note", "Input was refused\n");
      }
    },
    [append, sessionId],
  );

  const clear = useCallback(() => {
    setSegments([]);
    setError(null);
  }, []);

  // Leaving the page stops what it started; the server kills on disconnect.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { segments, running, error, history, run, stop, sendInput, clear };
}
