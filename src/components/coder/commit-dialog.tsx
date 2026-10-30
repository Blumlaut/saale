"use client";

import { useEffect, useState } from "react";
import { GitCommitHorizontal, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { useGitActions } from "./use-git-actions";
import type { CoderSessionState } from "./use-coder-data";

/** How a conflict row reads next to the box, where there is room for words. */
function conflictCount(state: CoderSessionState): number {
  return state.changes.filter((change) => change.conflicted).length;
}

/**
 * The commit message, in a dialog.
 *
 * The panel has no room to keep a message box around, and a box sitting empty
 * over a clean tree is furniture: the caller opens this when there is something
 * to commit. A commit takes what is staged, so an empty index stages everything
 * first, which is what a user who typed a message meant.
 */
export function CommitDialog({
  open,
  onOpenChange,
  state,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: CoderSessionState;
  actions: ReturnType<typeof useGitActions>;
}) {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);

  const staged = state.changes.filter((change) => change.staged).length;
  const conflicted = conflictCount(state);
  const head = state.commits[0] ?? null;
  const ready = message.trim() !== "" && conflicted === 0 && (amend || state.changes.length > 0);

  // A fresh open starts on the branch's own words, not the last commit's.
  useEffect(() => {
    if (!open) return;
    setMessage("");
    setAmend(false);
  }, [open]);

  const commit = async (push: boolean) => {
    const text = message.trim();
    if (!text) return;
    if (staged === 0 && !amend) {
      const stagedAll = await actions.run({ action: "stage" }, "Staged everything");
      if (!stagedAll) return;
    }
    const done = await actions.run({ action: "commit", message: text, amend, push });
    if (done) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !actions.isRunning("commit") && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{amend ? "Amend the last commit" : "Commit changes"}</DialogTitle>
          <DialogDescription>
            {staged > 0
              ? `${staged} file${staged === 1 ? "" : "s"} staged on ${state.branch}.`
              : `Everything in the worktree is staged first, then committed to ${state.branch}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void commit(false);
              }
            }}
            rows={5}
            placeholder={amend ? (head?.subject ?? "Amend the last commit") : "What changed"}
            aria-label="Commit message"
            className="min-h-28 resize-none font-mono text-xs"
            disabled={actions.busy}
          />

          <div className="flex items-center gap-2">
            <Checkbox
              id="amend-commit"
              checked={amend}
              disabled={!head || actions.busy}
              onCheckedChange={(checked) => {
                setAmend(checked);
                if (checked) setMessage(head?.subject ?? "");
              }}
            />
            <label htmlFor="amend-commit" className="text-muted-foreground text-xs">
              Amend the last commit
            </label>
          </div>

          {conflicted > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-red-600 dark:text-red-400">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
              Resolve {conflicted === 1
                ? "the conflicted file"
                : `${conflicted} conflicted files`}{" "}
              before committing.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={actions.busy}>
            Cancel
          </Button>
          <Button variant="secondary" disabled={!ready} onClick={() => void commit(true)}>
            Commit and push
          </Button>
          <Button disabled={!ready} onClick={() => void commit(false)}>
            {actions.isRunning("commit") ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitCommitHorizontal className="h-3.5 w-3.5" />
            )}
            Commit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
