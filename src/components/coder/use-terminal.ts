"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The terminal panel's state: the scrollback, and what is running.
 *
 * One command at a time, like a shell, and the panel keeps what earlier ones
 * printed: the scrollback is the panel's, the server only replays the run that
 * is current. Output is kept as segments so a build's stdout and stderr can be
 * tinted apart, and it is capped: a dev server prints for as long as it runs,
 * and the panel is not a log file.
 *
 * The command is not this panel's: it runs on the server until it exits or the
 * user stops it, so leaving the page detaches the stream and nothing else. Coming
 * back replays what the run printed while it was gone.
 */

/** How much output the panel keeps before it drops the oldest. */
const MAX_OUTPUT_CHARS = 400_000;
/** Lines the up arrow remembers. */
const MAX_HISTORY = 100;

export interface TerminalSegment {
  id: number;
  stream: "stdout" | "stderr" | "note" | "input";
  text: string;
}

/** One command and everything it printed. */
export interface TerminalBlock {
  id: number;
  /** The run's start on the server, which is what a replay is keyed by. */
  runId: number | null;
  command: string;
  segments: TerminalSegment[];
}

export interface TerminalRun {
  execId: string | null;
  command: string;
}

export interface TerminalState {
  blocks: TerminalBlock[];
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

function countChars(blocks: TerminalBlock[]): number {
  return blocks.reduce(
    (sum, block) => sum + block.segments.reduce((chars, segment) => chars + segment.text.length, 0),
    0,
  );
}

/** Drop the oldest output until the scrollback is back under its cap. */
function trimBlocks(blocks: TerminalBlock[]): TerminalBlock[] {
  let total = countChars(blocks);
  if (total <= MAX_OUTPUT_CHARS) return blocks;

  const next = blocks.slice();
  while (total > MAX_OUTPUT_CHARS && next.length > 0) {
    const block = next[0] as TerminalBlock;
    const segments = block.segments.slice();
    while (total > MAX_OUTPUT_CHARS && segments.length > 0) {
      const segment = segments[0] as TerminalSegment;
      const excess = total - MAX_OUTPUT_CHARS;
      if (segment.text.length <= excess) {
        segments.shift();
        total -= segment.text.length;
      } else {
        segments[0] = { ...segment, text: segment.text.slice(excess) };
        total -= excess;
      }
    }
    if (segments.length === 0) next.shift();
    else next[0] = { ...block, segments };
  }

  return next;
}

export function useTerminal(sessionId: string): TerminalState {
  const [blocks, setBlocks] = useState<TerminalBlock[]>([]);
  const [running, setRunning] = useState<TerminalRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const streamRef = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  // Mirrors `running` for the keystroke path, which needs it without waiting
  // for a render.
  const runningRef = useRef<TerminalRun | null>(null);
  // The block output belongs to until the run ends.
  const runIdRef = useRef<number | null>(null);

  const setRun = useCallback((next: TerminalRun | null) => {
    runningRef.current = next;
    setRunning(next);
  }, []);

  /**
   * Show a run, opening a block for one the panel has not seen.
   *
   * A replay of a run that is already on screen replaces that block's output
   * rather than adding a second copy, and leaves earlier commands alone.
   */
  const openRun = useCallback((runId: number, command: string) => {
    runIdRef.current = runId;
    setBlocks((current) => {
      const index = current.findIndex((block) => block.runId === runId);
      if (index === -1) {
        return [...current, { id: nextId.current++, runId, command, segments: [] }];
      }
      const next = current.slice();
      next[index] = { ...(current[index] as TerminalBlock), command, segments: [] };
      return next;
    });
  }, []);

  const append = useCallback((runId: number, stream: TerminalSegment["stream"], text: string) => {
    if (!text) return;
    setBlocks((current) => {
      const index = current.findIndex((block) => block.runId === runId);
      if (index === -1) return current;

      const block = current[index] as TerminalBlock;
      const last = block.segments[block.segments.length - 1];
      const segments =
        last && last.stream === stream
          ? [...block.segments.slice(0, -1), { ...last, text: last.text + text }]
          : [...block.segments, { id: nextId.current++, stream, text }];

      const next = current.slice();
      next[index] = { ...block, segments };
      return trimBlocks(next);
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

    setError(null);
    let runId: number | null = null;

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
            runId = typeof payload.startedAt === "number" ? payload.startedAt : Date.now();
            openRun(runId, payload.command);
            setRun({ execId: runningRef.current?.execId ?? null, command: payload.command });
          } else if (frame.event === "started" && typeof payload.execId === "string") {
            setRun({ execId: payload.execId, command: runningRef.current?.command ?? "" });
          } else if (frame.event === "data" && typeof payload.text === "string") {
            if (runId === null) continue;
            append(runId, payload.stream === "stderr" ? "stderr" : "stdout", payload.text);
          } else if (frame.event === "exit") {
            const code = typeof payload.exitCode === "number" ? payload.exitCode : 1;
            const millis = typeof payload.durationMs === "number" ? payload.durationMs : 0;
            if (runId !== null) append(runId, "note", exitNote(code, millis));
            setRun(null);
          } else if (frame.event === "error" && typeof payload.message === "string") {
            setError(payload.message);
            if (runId !== null) append(runId, "note", `${payload.message}\n`);
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
  }, [append, openRun, sessionId, setRun]);

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
          setBlocks((current) => [
            ...current,
            {
              id: nextId.current++,
              runId: null,
              command: trimmed,
              segments: [{ id: nextId.current++, stream: "note", text: `${message}\n` }],
            },
          ]);
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
    [attach, sessionId, setRun],
  );

  const stop = useCallback(() => {
    void fetch(`/api/coder/sessions/${sessionId}/terminal/stop`, { method: "POST" })
      .then((response) => {
        if (!response.ok && runIdRef.current !== null) {
          append(runIdRef.current, "note", `Could not stop the command (${response.status})\n`);
        }
      })
      .catch((err) => {
        console.error("Failed to stop the terminal command:", err);
      });
  }, [append, sessionId]);

  const clear = useCallback(() => {
    setBlocks([]);
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

      if (runIdRef.current !== null) append(runIdRef.current, "input", text);
      try {
        const response = await fetch(`/api/coder/sessions/${sessionId}/terminal/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ execId, data: text }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          if (runIdRef.current !== null) {
            append(runIdRef.current, "note", `${body.error ?? "Input was refused"}\n`);
          }
        }
      } catch (err) {
        console.error("Failed to send terminal input:", err);
        if (runIdRef.current !== null) append(runIdRef.current, "note", "Input was refused\n");
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

  return { blocks, running, error, history, run, stop, sendInput, clear };
}
