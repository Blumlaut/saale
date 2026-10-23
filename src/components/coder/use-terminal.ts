"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The terminal panel's state: what a command printed, and what is running.
 *
 * One command at a time, like a shell. Output is kept as segments so a build's
 * stdout and stderr can be tinted apart, and it is capped: a dev server prints
 * for as long as it runs, and the panel is not a log file.
 *
 * The command is not this panel's: it runs on the server until it exits or the
 * user stops it, so leaving the page detaches the stream and nothing else. Coming
 * back replays what the run printed while it was gone.
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

/** A command's exit as the panel writes it. */
function exitNote(code: number, millis: number): string {
  return `exit ${code} · ${(millis / 1000).toFixed(1)}s\n`;
}

export function useTerminal(sessionId: string): TerminalState {
  const [segments, setSegments] = useState<TerminalSegment[]>([]);
  const [running, setRunning] = useState<TerminalRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const streamRef = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  // Mirrors `running` for the keystroke path, which needs it without waiting
  // for a render.
  const runningRef = useRef<TerminalRun | null>(null);

  const setRun = useCallback((next: TerminalRun | null) => {
    runningRef.current = next;
    setRunning(next);
  }, []);

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

  /**
   * Follow the chat's run.
   *
   * The panel renders what the server replays, so it shows the same thing
   * whether the command was started here a moment ago or an hour ago.
   */
  const attach = useCallback(async () => {
    streamRef.current?.abort();
    const controller = new AbortController();
    streamRef.current = controller;

    setSegments([]);
    setError(null);

    try {
      const response = await fetch(`/api/coder/sessions/${sessionId}/terminal/stream`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        console.error(`Terminal stream answered ${response.status} for chat ${sessionId}`);
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

          if (frame.event === "command" && typeof payload.command === "string") {
            append("input", `$ ${payload.command}\n`);
            setRun({ execId: runningRef.current?.execId ?? null, command: payload.command });
          } else if (frame.event === "started" && typeof payload.execId === "string") {
            setRun({ execId: payload.execId, command: runningRef.current?.command ?? "" });
          } else if (frame.event === "data" && typeof payload.text === "string") {
            append(payload.stream === "stderr" ? "stderr" : "stdout", payload.text);
          } else if (frame.event === "exit") {
            const code = typeof payload.exitCode === "number" ? payload.exitCode : 1;
            const millis = typeof payload.durationMs === "number" ? payload.durationMs : 0;
            append("note", exitNote(code, millis));
            setRun(null);
          } else if (frame.event === "error" && typeof payload.message === "string") {
            setError(payload.message);
            append("note", `${payload.message}\n`);
            setRun(null);
          }
        }
      }
    } catch (err) {
      // Detaching is how leaving the page works, not a failure.
      if ((err as Error)?.name !== "AbortError") {
        console.error("Terminal stream failed:", err);
        setError(err instanceof Error ? err.message : "Terminal failed");
      }
    } finally {
      if (streamRef.current === controller) streamRef.current = null;
    }
  }, [append, sessionId, setRun]);

  const run = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed || runningRef.current) return;

      setError(null);
      setHistory((current) => [...current.slice(-(MAX_HISTORY - 1)), trimmed]);

      try {
        const response = await fetch(`/api/coder/sessions/${sessionId}/terminal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: trimmed }),
        });

        if (!response.ok) {
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
      } catch (err) {
        console.error("Terminal command failed:", err);
        setError(err instanceof Error ? err.message : "Terminal failed");
        return;
      }

      // The run is the server's now; the stream shows it from the first byte.
      setRun({ execId: null, command: trimmed });
      await attach();
    },
    [append, attach, sessionId, setRun],
  );

  const stop = useCallback(() => {
    void fetch(`/api/coder/sessions/${sessionId}/terminal/stop`, { method: "POST" })
      .then((response) => {
        if (!response.ok) append("note", `Could not stop the command (${response.status})\n`);
      })
      .catch((err) => {
        console.error("Failed to stop the terminal command:", err);
        append("note", "Could not stop the command\n");
      });
  }, [append, sessionId]);

  const clear = useCallback(() => {
    setSegments([]);
    setError(null);
    void fetch(`/api/coder/sessions/${sessionId}/terminal`, { method: "DELETE" }).catch((err) => {
      console.error("Failed to clear the terminal:", err);
    });
  }, [sessionId]);

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

  // Pick up whatever the chat already has running; leaving only detaches.
  useEffect(() => {
    void attach();
    return () => {
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, [attach]);

  return { segments, running, error, history, run, stop, sendInput, clear };
}
