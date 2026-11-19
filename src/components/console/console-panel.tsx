"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Loader2, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useColorMode } from "@/hooks/use-color-mode";
import { terminalTheme } from "@/components/coder/terminal-theme";
import { parseSseFrames } from "@/lib/pi/stream-logic";
import type { ShellState } from "@/lib/terminal/protocol";

/** How much a session may print before the oldest lines go. */
const SCROLLBACK_LINES = 5000;
const FONT_SIZE_PX = 11;
const LINE_HEIGHT = 1.35;
/** A panel drag resizes in steps; the shell is told once the drag settles. */
const FIT_DEBOUNCE_MS = 150;
/** Keystrokes leave together: one request per character would be thousands. */
const INPUT_BATCH_MS = 16;

type Status = "connecting" | "open" | "closed";

interface ConsoleStatus {
  status: Status;
  error: string | null;
}

/**
 * The files page's terminal: a shell on the workspace being browsed.
 *
 * It is a real terminal: keystrokes go to the shell as they are typed, so a
 * full-screen program draws and reads on the same screen.
 * The shell itself lives on the server (see `shell-sessions.ts`), which is why
 * switching tabs and coming back shows the session it left.
 */
export function ConsolePanel({ target }: { target: string }) {
  const mode = useColorMode();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Output can arrive before the terminal exists, so it waits here.
  const pendingRef = useRef<string[]>([]);
  const [state, setState] = useState<ConsoleStatus>({ status: "connecting", error: null });
  // Mirrors the status for callbacks that need it without a render.
  const liveRef = useRef(false);
  /** Keystrokes waiting for the next flush, and the timer that runs it. */
  const queued = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Writes leave in the order they were typed, one request at a time. */
  const inputQueue = useRef<Promise<void>>(Promise.resolve());

  /** Tell the shell how big the terminal is, once it is there to listen. */
  const pushSize = useCallback(
    (cols: number, rows: number) => {
      void fetch(`/api/terminal/resize?target=${encodeURIComponent(target)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch((err) => console.error("Failed to resize the terminal:", err));
    },
    [target],
  );

  const write = useCallback((text: string) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      pendingRef.current.push(text);
      return;
    }
    terminal.write(text);
  }, []);

  // The terminal itself. Recreated only for another font, never per shell.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const styles = getComputedStyle(surface);
    const terminal = new Terminal({
      scrollback: SCROLLBACK_LINES,
      fontFamily: styles.fontFamily,
      fontSize: FONT_SIZE_PX,
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      // The shell reads what the keyboard writes, as a terminal should.
      disableStdin: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(surface);
    terminalRef.current = terminal;

    fit.fit();
    for (const text of pendingRef.current) terminal.write(text);
    pendingRef.current = [];

    const flush = () => {
      flushTimer.current = null;
      const data = queued.current;
      queued.current = "";
      if (!data) return;

      inputQueue.current = inputQueue.current
        .then(async () => {
          const response = await fetch(`/api/terminal/input?target=${encodeURIComponent(target)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data }),
          });
          if (!response.ok) console.error(`The terminal refused input (${response.status})`);
        })
        .catch((err) => console.error("Failed to type into the terminal:", err));
    };

    // Keystrokes leave in one write per frame's worth of typing, in order: a
    // request per character is both a flood and an order that can swap.
    const send = terminal.onData((data) => {
      if (!liveRef.current) return;
      queued.current += data;
      flushTimer.current ??= setTimeout(flush, INPUT_BATCH_MS);
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const applySize = () => {
      // A tab behind another has no box, and a fit against nothing would tell
      // the shell it is two columns wide and leave a full-screen program
      // drawing into it.
      if (surface.clientWidth === 0 || surface.clientHeight === 0) return;
      fit.fit();
      pushSize(terminal.cols, terminal.rows);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(applySize, FIT_DEBOUNCE_MS);
          });
    observer?.observe(surface);

    return () => {
      if (timer) clearTimeout(timer);
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      observer?.disconnect();
      send.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [pushSize, target]);

  // The colours follow the mode, and the surface they are read from.
  useEffect(() => {
    const surface = surfaceRef.current;
    const terminal = terminalRef.current;
    if (!surface || !terminal) return;
    terminal.options.theme = terminalTheme(getComputedStyle(surface), mode === "dark");
  }, [mode]);

  const controllerRef = useRef<AbortController | null>(null);

  const attach = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    liveRef.current = true;

    try {
      const opened = await fetch(`/api/terminal?target=${encodeURIComponent(target)}`, {
        method: "POST",
      });
      if (!opened.ok) {
        const body = (await opened.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not open the terminal (${opened.status})`);
      }

      const state = (await opened.json()) as { shell: ShellState };
      // A shell starts at the terminal's default size, so the panel says its
      // own now that there is one to tell.
      const terminal = terminalRef.current;
      if (terminal) pushSize(terminal.cols, terminal.rows);
      setState({
        status: state.shell.status === "closed" ? "closed" : "open",
        error: state.shell.error,
      });

      const response = await fetch(`/api/terminal/stream?target=${encodeURIComponent(target)}`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`The terminal stream answered ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // A reader that was replaced must not paint the buffer it replayed:
        // two of them would write the same output twice, in pieces.
        if (controller.signal.aborted) return;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;

        for (const event of parsed.frames) {
          const payload = payloadOf(event.data);
          if (!payload) continue;
          if (payload.type === "output") {
            write(payload.text);
          } else {
            liveRef.current = false;
            setState({ status: "closed", error: payload.error });
          }
        }
      }
    } catch (err) {
      // Detaching is how leaving the tab works.
      if ((err as Error)?.name !== "AbortError") {
        console.error("The terminal stream failed:", err);
        liveRef.current = false;
        setState({
          status: "closed",
          error: err instanceof Error ? err.message : "The terminal failed",
        });
      }
    }
  }, [pushSize, target, write]);

  // One shell per target: the panel attaches when it is shown and detaches when
  // it is put away. The shell keeps running either way.
  useEffect(() => {
    void attach();
    return () => {
      liveRef.current = false;
      controllerRef.current?.abort();
    };
  }, [attach]);

  const close = useCallback(async () => {
    const response = await fetch(`/api/terminal?target=${encodeURIComponent(target)}`, {
      method: "DELETE",
    }).catch((err: unknown) => {
      console.error("Failed to close the terminal:", err);
      return null;
    });
    if (!response?.ok) return;

    liveRef.current = false;
    setState({ status: "closed", error: null });
  }, [target]);

  const restart = () => {
    setState({ status: "connecting", error: null });
    terminalRef.current?.reset();
    void attach();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <StatusDot status={state.status} />
        <p className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
          {state.status === "connecting"
            ? "Opening a shell…"
            : state.status === "open"
              ? "Shell running"
              : "Shell closed"}
        </p>
        {state.status === "closed" ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={restart}
          >
            <Power className="h-3.5 w-3.5" />
            Start
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close the shell"
            className="h-7 w-7"
            onClick={() => void close()}
          >
            <Power className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Clear the terminal"
          className="h-7 w-7"
          onClick={() => terminalRef.current?.clear()}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      {state.error ? (
        <p className="text-destructive shrink-0 px-2 py-1 text-[11px] break-words">{state.error}</p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={surfaceRef}
          role="group"
          aria-label="Terminal"
          className="terminal-surface absolute inset-0 overflow-hidden font-mono"
        />
        {state.status === "connecting" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden
      className={
        status === "open"
          ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
          : status === "connecting"
            ? "bg-primary size-1.5 shrink-0 animate-pulse rounded-full"
            : "bg-muted-foreground/50 size-1.5 shrink-0 rounded-full"
      }
    />
  );
}

/** What a shell stream's frame carries, when it carries something readable. */
function payloadOf(data: string): OutputEvent | ClosedEvent | null {
  try {
    return JSON.parse(data) as OutputEvent | ClosedEvent;
  } catch (err) {
    console.error("Malformed terminal frame:", err);
    return null;
  }
}

type OutputEvent = { type: "output"; text: string };
type ClosedEvent = { type: "closed"; error: string | null };
