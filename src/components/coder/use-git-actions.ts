"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { postJson } from "@/lib/http";

/**
 * What the panel sends to `POST /api/coder/sessions/:id/git`.
 *
 * The server validates this again; the shape here only keeps the caller honest
 * about which actions exist.
 */
export type GitActionRequest =
  | { action: "fetch" }
  | { action: "pull"; rebase?: boolean }
  | { action: "push" }
  | { action: "commit"; message: string; amend?: boolean; push?: boolean }
  | { action: "stage"; paths?: string[] }
  | { action: "unstage"; paths?: string[] }
  | { action: "discard"; paths: string[] }
  | { action: "branch"; name: string; create?: boolean }
  | { action: "stash" }
  | { action: "stash-pop" }
  | { action: "undo-commit" };

/** The toast copy per action, so a button only says what it is doing. */
const DONE: Record<GitActionRequest["action"], string> = {
  fetch: "Fetched from the remote",
  pull: "Pulled",
  push: "Pushed",
  commit: "Committed",
  stage: "Staged",
  unstage: "Unstaged",
  discard: "Discarded",
  branch: "Switched branch",
  stash: "Stashed",
  "stash-pop": "Restored the stash",
  "undo-commit": "Undid the last commit",
};

/**
 * The panel's git buttons.
 *
 * One action at a time: the row that asked shows a spinner, every other button
 * is disabled, and the poll refresh runs afterwards either way so the panel
 * never shows a tree from before the command.
 */
export function useGitActions(sessionId: string, onDone: () => void) {
  const [running, setRunning] = useState<{ action: string; paths: string[] } | null>(null);

  const run = useCallback(
    async (body: GitActionRequest, done = DONE[body.action]): Promise<boolean> => {
      setRunning({
        action: body.action,
        paths: "paths" in body ? (body.paths ?? []) : [],
      });
      try {
        await postJson(`/api/coder/sessions/${encodeURIComponent(sessionId)}/git`, body);
        toast.success(done);
        return true;
      } catch (err) {
        console.error(`git ${body.action} failed for ${sessionId}:`, err);
        const message = err instanceof Error ? err.message : "Could not run that git command";
        toast.error(`${DONE[body.action]} failed`, { description: message.slice(0, 300) });
        return false;
      } finally {
        setRunning(null);
        onDone();
      }
    },
    [sessionId, onDone],
  );

  /** Whether the button for this action, on this path, is the one running. */
  const isRunning = useCallback(
    (action: GitActionRequest["action"], path?: string) =>
      running?.action === action && (path === undefined || running.paths.includes(path)),
    [running],
  );

  return { run, busy: running !== null, isRunning };
}
