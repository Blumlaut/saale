"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ban, CornerDownLeft, Trash2, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTerminal } from "./use-terminal";

/**
 * A command runner in the chat's worktree.
 *
 * One shell's worth of commands, each in a fresh `bash -c` with stdin attached,
 * so a prompt the command prints can be answered in the input below. Nothing
 * here is a login shell: the worktree is the working directory and there is no
 * way to leave it, because the panel never sends a path.
 */

/** How close to the bottom still counts as following the output. */
const FOLLOW_SLACK_PX = 32;

/** Whether the user has text selected inside `element`. */
function hasSelectionIn(element: HTMLElement | null): boolean {
  if (!element) return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return element.contains(range.commonAncestorContainer);
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
  const { blocks, running, error, history, run, stop, sendInput, clear } = useTerminal(sessionId);

  // Let the parent launch commands into this terminal (e.g. a script button).
  useEffect(() => {
    registerRun?.(run);
  }, [registerRun, run]);
  const [draft, setDraft] = useState("");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Only follow the output while the user is at the bottom: scrolling up to
  // read a stack trace should not be undone by the next line.
  const pinnedRef = useRef(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [blocks]);

  // Output streaming in must not scroll a selection the user is reading.
  useEffect(() => {
    const onSelectionChange = () => {
      const element = scrollRef.current;
      if (!element) return;
      if (hasSelectionIn(element)) {
        pinnedRef.current = false;
        return;
      }
      pinnedRef.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
  }, []);

  // The terminal stays mounted while its tab is hidden, where it has no height
  // to follow; catching up when it is shown again needs the resize.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Clicking the output types into the prompt, unless the click was a selection. */
  const focusInput = useCallback(() => {
    if (hasSelectionIn(scrollRef.current)) return;
    inputRef.current?.focus();
  }, []);

  const submit = useCallback(() => {
    const line = draft;
    setDraft("");
    setHistoryIndex(null);

    if (running) {
      // Answering a prompt: the command is still open on stdin, and an empty
      // line is a valid answer.
      void sendInput(`${line}\n`);
      return;
    }
    if (!line.trim()) return;
    void run(line);
  }, [draft, running, run, sendInput]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
        return;
      }
      if (event.key === "c" && event.ctrlKey) {
        event.preventDefault();
        if (running) void sendInput("\u0003");
        return;
      }
      // The input is emptied for a running command, so history is only for the
      // prompt.
      if (running) return;
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

  useEffect(() => {
    if (running) return;
    // A command finishing must not take focus away from a selection.
    if (hasSelectionIn(scrollRef.current)) return;
    inputRef.current?.focus();
  }, [running]);

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
            disabled={blocks.length === 0}
            className="h-7 w-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={focusInput}
        className="min-h-0 flex-1 cursor-text overflow-y-auto px-2 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
      >
        {blocks.length === 0 ? (
          <p className="text-muted-foreground">Run something in this worktree.</p>
        ) : null}
        {blocks.map((block) => (
          <Fragment key={block.id}>
            <span className="text-primary">{`$ ${block.command}\n`}</span>
            {block.segments.map((segment) => (
              <span
                key={segment.id}
                className={cn(
                  segment.stream === "stderr" && "text-amber-600 dark:text-amber-400",
                  segment.stream === "note" && "text-muted-foreground",
                  segment.stream === "input" && "text-primary",
                )}
              >
                {segment.text}
              </span>
            ))}
          </Fragment>
        ))}
      </div>

      {error ? <p className="text-destructive shrink-0 px-2 pb-1 text-[11px]">{error}</p> : null}

      <div className="flex shrink-0 items-center gap-1.5 border-t px-2 py-1.5">
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{prompt}</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? "Answer the prompt…" : "npm test"}
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
