"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { CoderChange } from "./use-coder-data";

/**
 * Confirmation for throwing changes away, because git cannot bring them back.
 *
 * The wording follows what git will actually do: a tracked file goes back to the
 * last commit, an untracked one is deleted.
 */
export function DiscardChangesDialog({
  changes,
  onOpenChange,
  onConfirm,
}: {
  /** The paths to discard; empty closes the box. */
  changes: CoderChange[];
  onOpenChange: (open: boolean) => void;
  /** Resolves true when git accepted every path. */
  onConfirm: (changes: CoderChange[]) => Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (changes.length > 0) setFailed(null);
  }, [changes]);

  const first = changes[0];
  const deletes = changes.some((change) => change.untracked);
  const title =
    changes.length === 1 && first
      ? `Discard changes to “${first.path}”?`
      : `Discard changes to ${changes.length} files?`;

  const confirm = async () => {
    setPending(true);
    try {
      const ok = await onConfirm(changes);
      if (ok) onOpenChange(false);
      else setFailed("git would not discard every file. Check the terminal for the reason.");
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={changes.length > 0} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {deletes
              ? "An untracked file is deleted, and a changed one goes back to the last commit. This cannot be undone."
              : "Files go back to the last commit. This cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {changes.length > 1 && (
          <div className="max-h-40 overflow-y-auto rounded-md border px-3 py-2">
            <ul className="space-y-0.5">
              {changes.map((change) => (
                <li key={change.path} className="text-muted-foreground font-mono text-xs break-all">
                  {change.path}
                </li>
              ))}
            </ul>
          </div>
        )}

        {failed && <p className="text-destructive text-xs break-words">{failed}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep changes</AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
            disabled={pending}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
