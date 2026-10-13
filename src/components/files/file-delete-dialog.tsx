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
import type { FileEntry } from "@/lib/files/types";

export interface FileDeleteDialogProps {
  /** Entries to delete; empty closes the dialog. */
  entries: FileEntry[];
  onOpenChange: (open: boolean) => void;
  /** Resolves true when every delete succeeded. */
  onConfirm: (entries: FileEntry[]) => Promise<boolean>;
}

/**
 * Confirmation for a delete, because there is no undo.
 *
 * Deleting a folder takes everything inside it, so the wording says so — and a
 * multi-selection lists what is about to go rather than asking "are you sure?"
 * about a number.
 */
export function FileDeleteDialog({ entries, onOpenChange, onConfirm }: FileDeleteDialogProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (entries.length > 0) setFailed(false);
  }, [entries]);

  const first = entries[0];
  const folders = entries.filter((entry) => entry.kind === "directory").length;
  const title =
    entries.length === 1 && first ? `Delete “${first.name}”?` : `Delete ${entries.length} items?`;

  async function confirm() {
    setPending(true);
    try {
      if (await onConfirm(entries)) onOpenChange(false);
      else setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={entries.length > 0} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {folders > 0
              ? `Folders are removed with everything inside them. This cannot be undone.`
              : "This cannot be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {entries.length > 1 && (
          // Long names wrap rather than pushing the dialog wider than the phone.
          <div className="max-h-40 overflow-y-auto rounded-md border px-3 py-2">
            <ul className="space-y-0.5">
              {entries.map((entry) => (
                <li key={entry.path} className="text-muted-foreground font-mono text-xs break-all">
                  {entry.name}
                  {entry.kind === "directory" ? "/" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}

        {failed && <p className="text-destructive text-xs">Something was not deleted.</p>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
