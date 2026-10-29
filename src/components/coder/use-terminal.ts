"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The terminal panel's state: what the chat's run printed, and what is running.
 *
 * One command at a time, like a shell. The panel's terminal holds the
 * scrollback; this hook only feeds it, in the order the server sent it, so a
 * program that draws a screen (a pager, a monitor) can paint over what it drew
 * before.
 *
 * The command is not this panel's: it runs on the server until it exits or the
 * user stops it, so leaving the page detaches the stream and nothing else. Coming
 * back replays what the run printed while it was gone.
 */

/** Lines the up arrow remembers. */
const MAX_HISTORY = 100;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** Where the run's output goes: the panel's terminal. */
export interface TerminalSink {
  write(text: string): void;
  /** Throw away everything on screen. */
  reset(): void;
}

export interface TerminalRun {
  execId: string | null;
  command: string;
}

export interface TerminalState {
  running: TerminalRun | null;
  /** Set when the last command answered with an error. */
  error: string | null;
  history: string[];
  run: (command: string, size: TerminalSize) => Promise<void>;
  stop: () => void;
  sendInput: (text: string) => Promise<void>;
  resize: (size: TerminalSize) => void;
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

/** The line the panel writes before a command's output. */
function promptLine(command: string): string {
  return `\x1b[1m$ ${command}\x1b[0m\r\n`;
}

/** A command's exit, dimmed so it reads as the panel talking. */
function exitLine(code: number, millis: number): string {
  return `\x1b[2mexit ${code} · ${(millis / 1000).toFixed(1)}s\x1b[0m\r\n`;
}

/** Something the panel has to say, in red. */
function errorLine(message: string): string {
  return `\x1b[31m${message}\x1b[0m\r\n`;
}

export function useTerminal(sessionId: string, sink: TerminalSink): TerminalState {
  const [running, setRunning] = useState<TerminalRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const streamRef = useRef<AbortController | null>(null);
  // Mirrors `running` for the keystroke path, which needs it without waiting
  // for a render.
  const runningRef = useRef<TerminalRun | null>(null);
  // The panel's own size, so a resize only goes out when it really changed.
  const sizeRef = useRef<TerminalSize | null>(null);
  // The sink belongs to the view's terminal; reading it through a ref keeps
  // every callback here stable.
  const sinkRef = useRef(sink);
  sinkRef.current = sink;

  const write = useCallback((text: string) => sinkRef.current.write(text), []);

  const setRun = useCallback((next: TerminalRun | null) => {
    runningRef.current = next;
    setRunning(next);
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
            write(promptLine(payload.command));
            setRun({ execId: runningRef.current?.execId ?? null, command: payload.command });
          } else if (frame.event === "started" && typeof payload.execId === "string") {
            setRun({ execId: payload.execId, command: runningRef.current?.command ?? "" });
          } else if (frame.event === "data" && typeof payload.text === "string") {
            write(payload.text);
          } else if (frame.event === "exit") {
            const code = typeof payload.exitCode === "number" ? payload.exitCode : 1;
            const millis = typeof payload.durationMs === "number" ? payload.durationMs : 0;
            write(exitLine(code, millis));
            setRun(null);
          } else if (frame.event === "error" && typeof payload.message === "string") {
            setError(payload.message);
            write(errorLine(payload.message));
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
  }, [sessionId, setRun, write]);

  const run = useCallback(
    async (command: string, size: TerminalSize) => {
      const trimmed = command.trim();
      if (!trimmed || runningRef.current) return;

      setError(null);
      setHistory((current) => [...current.slice(-(MAX_HISTORY - 1)), trimmed]);
      sizeRef.current = size;

      try {
        const response = await fetch(`/api/coder/sessions/${sessionId}/terminal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: trimmed, cols: size.cols, rows: size.rows }),
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
          write(`${promptLine(trimmed)}${errorLine(message)}`);
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
    [attach, sessionId, setRun, write],
  );

  const stop = useCallback(() => {
    void fetch(`/api/coder/sessions/${sessionId}/terminal/stop`, { method: "POST" })
      .then((response) => {
        if (!response.ok) {
          write(errorLine(`Could not stop the command (${response.status})`));
        }
      })
      .catch((err) => {
        console.error("Failed to stop the terminal command:", err);
      });
  }, [sessionId, write]);

  const clear = useCallback(() => {
    sinkRef.current.reset();
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

      try {
        const response = await fetch(`/api/coder/sessions/${sessionId}/terminal/input`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ execId, data: text }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          write(errorLine(body.error ?? "Input was refused"));
        }
      } catch (err) {
        console.error("Failed to send terminal input:", err);
        write(errorLine("Input was refused"));
      }
    },
    [sessionId, write],
  );

  const resize = useCallback(
    (size: TerminalSize) => {
      const previous = sizeRef.current;
      sizeRef.current = size;
      if (previous && previous.cols === size.cols && previous.rows === size.rows) return;
      if (!runningRef.current) return;

      void fetch(`/api/coder/sessions/${sessionId}/terminal/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: size.cols, rows: size.rows }),
      }).catch((err) => {
        console.error("Failed to resize the terminal:", err);
      });
    },
    [sessionId],
  );

  // Pick up whatever the chat already has running; leaving only detaches.
  useEffect(() => {
    void attach();
    return () => {
      streamRef.current?.abort();
      streamRef.current = null;
    };
  }, [attach]);

  return { running, error, history, run, stop, sendInput, resize, clear };
}
