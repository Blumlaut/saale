"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
export function TerminalView({
  sessionId,
  worktree,
}: {
  sessionId: string;
  /** Null until the chat's first message has built the worktree. */
  worktree: { path: string; branch: string } | null;
}) {
  const { segments, running, error, history, run, stop, sendInput, clear } = useTerminal(sessionId);
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
  }, [segments]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
  }, []);

  const submit = useCallback(() => {
    const line = draft;
    setDraft("");
    setHistoryIndex(null);
    if (!line.trim()) return;

    if (running) {
      // Answering a prompt: the command is still open on stdin.
      void sendInput(`${line}\n`);
      return;
    }
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
    if (!running) inputRef.current?.focus();
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
            disabled={segments.length === 0}
            className="h-7 w-7"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onClick={() => inputRef.current?.focus()}
        className="min-h-0 flex-1 cursor-text overflow-y-auto px-2 py-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap"
      >
        {segments.length === 0 ? (
          <p className="text-muted-foreground">Run something in this worktree.</p>
        ) : null}
        {segments.map((segment) => (
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
          disabled={draft.trim().length === 0}
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
