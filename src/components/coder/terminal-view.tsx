"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Ban, CornerDownLeft, Trash2, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useColorMode } from "@/hooks/use-color-mode";
import { terminalTheme } from "./terminal-theme";
import { useTerminal, type TerminalSink, type TerminalSize } from "./use-terminal";

/**
 * A terminal in the chat's worktree.
 *
 * One shell's worth of commands, each in a fresh `bash -c` on a pty, so a
 * program that draws a screen (a monitor, a pager, a prompt) has a terminal to
 * draw on. Nothing here is a login shell: the worktree is the working directory
 * and there is no way to leave it, because the panel never sends a path.
 */

/** How much a command may print before the oldest lines go. */
const SCROLLBACK_LINES = 5000;
const FONT_SIZE_PX = 11;
const LINE_HEIGHT = 1.35;
/** A panel drag resizes in steps; the run is told once the drag settles. */
const FIT_DEBOUNCE_MS = 150;

/** Keys that mean something to a full-screen program, as it expects to read them. */
const KEYS: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
};

/** The bytes a keystroke sends, when it is not a plain character. */
function specialKey(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  if (event.ctrlKey) {
    if (event.key.length !== 1) return KEYS[event.key] ?? null;
    // Ctrl-A is \x01 and so on up to Ctrl-_ at \x1f.
    const code = event.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
    return null;
  }
  if (event.metaKey) return null;
  const key = KEYS[event.key];
  if (key) return key;
  if (event.altKey && event.key.length === 1) return `\x1b${event.key}`;
  return null;
}

export function TerminalView({
  sessionId,
  worktree,
  registerRun,
}: {
  sessionId: string;
  /** Null until the chat's first message has built the worktree. */
  worktree: { path: string; branch: string } | null;
  /** Hands the terminal's run function to a parent so other tabs can launch commands. */
  registerRun?: (run: (command: string) => void) => void;
}) {
  if (!worktree) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <TerminalSquare className="text-muted-foreground h-5 w-5" />
        <p className="text-muted-foreground text-xs">
          The worktree appears after this chat&apos;s first message, and the terminal opens in it.
        </p>
      </div>
    );
  }

  return <TerminalPanel sessionId={sessionId} worktree={worktree} registerRun={registerRun} />;
}

function TerminalPanel({
  sessionId,
  worktree,
  registerRun,
}: {
  sessionId: string;
  worktree: { path: string; branch: string };
  registerRun?: ((run: (command: string) => void) => void) | undefined;
}) {
  const mode = useColorMode();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Output can arrive before the terminal exists, so it waits here.
  const pendingRef = useRef<string[]>([]);
  const sizeRef = useRef<TerminalSize>({ cols: 80, rows: 24 });

  const [draft, setDraft] = useState("");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const sink = useMemo<TerminalSink>(
    () => ({
      write(text) {
        const terminal = terminalRef.current;
        if (!terminal) {
          pendingRef.current.push(text);
          return;
        }
        terminal.write(text);
      },
      reset() {
        pendingRef.current = [];
        terminalRef.current?.reset();
      },
    }),
    [],
  );

  const { running, error, history, run, stop, sendInput, resize, clear } = useTerminal(
    sessionId,
    sink,
  );

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const styles = getComputedStyle(surface);
    const terminal = new Terminal({
      cols: sizeRef.current.cols,
      rows: sizeRef.current.rows,
      scrollback: SCROLLBACK_LINES,
      fontFamily: styles.fontFamily,
      fontSize: FONT_SIZE_PX,
      lineHeight: LINE_HEIGHT,
      cursorBlink: true,
      // The prompt row under the terminal is where the keystrokes are typed.
      disableStdin: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(surface);
    terminalRef.current = terminal;

    for (const text of pendingRef.current) terminal.write(text);
    pendingRef.current = [];

    const measure = () => {
      fit.fit();
      const next = { cols: terminal.cols, rows: terminal.rows };
      if (next.cols === sizeRef.current.cols && next.rows === sizeRef.current.rows) return;
      sizeRef.current = next;
      resize(next);
    };
    measure();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(measure, FIT_DEBOUNCE_MS);
          });
    observer?.observe(surface);

    return () => {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [resize]);

  // Paints the terminal, including on the mount that follows its creation.
  useEffect(() => {
    const surface = surfaceRef.current;
    const terminal = terminalRef.current;
    if (!surface || !terminal) return;
    terminal.options.theme = terminalTheme(getComputedStyle(surface), mode === "dark");
  }, [mode]);

  // Let the parent launch commands into this terminal (e.g. a script button).
  const runCommand = useCallback(
    (command: string) => {
      void run(command, sizeRef.current);
    },
    [run],
  );

  useEffect(() => {
    registerRun?.(runCommand);
  }, [registerRun, runCommand]);

  // A click on the output types into the prompt, unless it was a selection.
  const onSurfaceClick = useCallback(() => {
    if (terminalRef.current?.hasSelection()) return;
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(() => {
    const line = draft;
    setDraft("");
    setHistoryIndex(null);

    if (running) {
      // Answering a prompt: the command is still open on stdin, and an empty
      // line is a valid answer.
      void sendInput(`${line}\r`);
      return;
    }
    if (!line.trim()) return;
    void run(line, sizeRef.current);
  }, [draft, running, run, sendInput]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (running) {
        // Plain characters reach the command through `onChange`, which also
        // carries a paste and an IME's finished word.
        const data = specialKey(event);
        if (data === null) return;
        event.preventDefault();
        void sendInput(data);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key === "ArrowUp") {
        if (history.length === 0) return;
        event.preventDefault();
        const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(index);
        setDraft(history[index] ?? "");
        return;
      }
      if (event.key === "ArrowDown") {
        if (historyIndex === null) return;
        event.preventDefault();
        const index = historyIndex + 1;
        if (index >= history.length) {
          setHistoryIndex(null);
          setDraft("");
        } else {
          setHistoryIndex(index);
          setDraft(history[index] ?? "");
        }
      }
    },
    [history, historyIndex, running, sendInput, submit],
  );

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      if (!running) {
        setDraft(value);
        return;
      }
      // Every character is a keystroke for the command that is running.
      if (value) void sendInput(value);
      setDraft("");
    },
    [running, sendInput],
  );

  useEffect(() => {
    if (running) {
      // A command started from elsewhere leaves nothing to type in the prompt.
      setDraft("");
      return;
    }
    // A command finishing must not take focus away from a selection.
    if (terminalRef.current?.hasSelection()) return;
    inputRef.current?.focus();
  }, [running]);

  const prompt = running ? "▸" : "$";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
        <span
          className="text-muted-foreground truncate font-mono text-[11px]"
          title={worktree.path}
        >
          {worktree.branch}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {running ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={stop}
              className="text-destructive h-7 gap-1 px-2 text-xs"
            >
              <Ban className="h-3.5 w-3.5" />
              Stop
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear the terminal"
            onClick={clear}
            className="h-7 w-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={surfaceRef}
        onClick={onSurfaceClick}
        role="group"
        aria-label="Terminal output"
        className="terminal-surface min-h-0 flex-1 overflow-hidden font-mono"
      />

      {error ? <p className="text-destructive shrink-0 px-2 pb-1 text-[11px]">{error}</p> : null}

      <div className="flex shrink-0 items-center gap-1.5 border-t px-2 py-1.5">
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{prompt}</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={running ? "Type into the running command…" : "npm test"}
          aria-label="Terminal command"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:opacity-50"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={running ? "Send input" : "Run command"}
          onClick={submit}
          disabled={!running && draft.trim().length === 0}
          className="h-7 w-7 shrink-0"
        >
          {running ? (
            <CornerDownLeft className="h-3.5 w-3.5" />
          ) : (
            <TerminalSquare className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
