"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * A new branch for the checkout.
 *
 * The name is only checked for empty here: git decides whether it is a legal
 * branch name, and its reason is what the user should read.
 */
export function NewBranchDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves true when the branch was created. */
  onCreate: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const submit = async () => {
    const wanted = name.trim();
    if (!wanted) return;
    setPending(true);
    try {
      if (await onCreate(wanted)) onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New branch</DialogTitle>
          <DialogDescription>
            git creates it from the current commit and checks it out in this worktree.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="feat/thing"
            aria-label="Branch name"
            className="font-mono text-sm"
          />
        </form>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending || name.trim() === ""}>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create branch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
