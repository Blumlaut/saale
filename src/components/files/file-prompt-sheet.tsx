"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { isSafeEntryName } from "@/lib/files/paths";

export interface FilePromptSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  initialValue?: string;
  /** Resolves true when the write succeeded; the sheet closes only then. */
  onSubmit: (value: string) => Promise<boolean>;
}

/**
 * One field, one action. used for both "New folder" and "Rename".
 *
 * They are the same interaction with different words, and a single component
 * means a single overlay to register and one place where a name is checked.
 */
export function FilePromptSheet({
  open,
  onOpenChange,
  title,
  description,
  label,
  submitLabel,
  initialValue = "",
  onSubmit,
}: FilePromptSheetProps) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);

  // Reopening for a different row must not carry the previous name over.
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  const trimmed = value.trim();
  const valid = isSafeEntryName(trimmed);

  async function submit() {
    if (!valid || pending) return;
    setPending(true);
    try {
      if (await onSubmit(trimmed)) onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              {title}
            </SheetTitle>
            <SheetDescription className="break-words">{description}</SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="file-prompt-name" className="text-xs">
                {label}
              </Label>
              <Input
                id="file-prompt-name"
                value={value}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              {trimmed !== "" && !valid && (
                <p className="text-destructive text-xs">
                  A name cannot contain a slash or be “.” or “..”.
                </p>
              )}
            </div>
          </div>

          <div className="border-t px-6 py-4">
            <Button className="w-full" disabled={!valid || pending} onClick={() => void submit()}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitLabel}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
