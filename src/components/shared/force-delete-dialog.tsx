"use client";

import { useState, type ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { isForcedRetryRefusal } from "@/lib/coder/force-delete";

/**
 * The confirmation for a delete that can lose uncommitted work.
 *
 * `onDelete` performs the delete at the level the user has confirmed. When it
 * throws a refusal carrying `WORKTREE_KEPT_CODE`, the box stays open, shows the
 * reason, and the next click discards the checkout anyway. Every delete path
 * shares this, so a new one only has to say what it is deleting.
 */
export function ForceDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  discard,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  /** What a forced retry throws away, e.g. "this chat's uncommitted changes". */
  discard: ReactNode;
  /** Runs the delete. Throw to keep the box open with the reason shown. */
  onDelete: (force: boolean) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [forcePending, setForcePending] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = (next: boolean) => {
    if (!next) {
      setError(null);
      setForcePending(false);
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(forcePending);
      setForcePending(false);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete it.");
      setForcePending(!forcePending && isForcedRetryRefusal(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-destructive text-sm break-words whitespace-pre-wrap">{error}</p>
        )}
        {forcePending && (
          <p className="text-sm break-words">Delete anyway, discarding {discard}?</p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/* A plain button: the box closes here, once the delete has landed. */}
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Loader2 /> : <Trash2 />}
            {forcePending ? "Delete anyway" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
