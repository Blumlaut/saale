"use client";

import { TriangleAlert } from "lucide-react";
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
import { isForcedRetry } from "@/lib/coder/force-delete";

/** What stopped a chat's delete, as the row and the box behind it carry it. */
export interface ChatDeleteError {
  /** The chat it belongs to, for the box's own title. */
  title: string;
  message: string;
  /** Set when a confirmed retry can get past the reason. */
  code: string | null | undefined;
}

/**
 * The red mark a chat that was not deleted wears.
 *
 * A removal runs on the server, so a chat whose delete stopped would otherwise
 * come back looking like nothing ever happened. The reason is kept on the row
 * until the next attempt, and this is how the user finds it.
 */
export function DeleteErrorMark({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-destructive shrink-0"
      aria-label={`Delete failed for ${title}`}
      onClick={onClick}
    >
      <TriangleAlert />
    </Button>
  );
}

/**
 * Why a chat is still here, and what can be done about it.
 *
 * `onRetry` runs the delete again with `force`, which is the only way past a
 * checkout holding work: the box closes and the row tells the rest.
 */
export function DeleteErrorDialog({
  error,
  onClose,
  onRetry,
}: {
  error: ChatDeleteError | null;
  onClose: () => void;
  onRetry: (force: boolean) => void;
}) {
  const forceable = isForcedRetry(error?.code ?? undefined);

  return (
    <AlertDialog open={error !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This chat was not deleted</AlertDialogTitle>
          <AlertDialogDescription>{error?.title ?? ""}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-destructive flex items-start gap-2 text-sm break-words whitespace-pre-wrap">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error?.message}</span>
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
          {forceable && (
            <Button variant="destructive" onClick={() => onRetry(true)}>
              Delete anyway
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
