"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PROMPT_ARGUMENT_HINT_MAX,
  PROMPT_DESCRIPTION_MAX,
  PROMPT_NAME_MAX,
  PROMPT_SCOPES,
  PROMPT_SCOPE_LABELS,
  type PromptScope,
} from "@/lib/prompts/rules";

/** The form's state. `id` absent means a new prompt. */
export interface PromptDraft {
  id?: string;
  name: string;
  description: string;
  argumentHint: string;
  scope: PromptScope;
  content: string;
}

export const EMPTY_PROMPT_DRAFT: PromptDraft = {
  name: "",
  description: "",
  argumentHint: "",
  scope: "any",
  content: "",
};

/**
 * The form one prompt is written in.
 *
 * The user's own prompts and the instance's shared ones take the same fields, so
 * the settings section and the admin page open this one. The page owns the draft
 * and the endpoint it is saved to.
 */
export function PromptDialog({
  open,
  draft,
  saving,
  error,
  description,
  onChange,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  /** Null while closed. */
  draft: PromptDraft | null;
  saving: boolean;
  error: string | null;
  /** What this prompt is for, in the caller's words. */
  description?: ReactNode;
  onChange: (draft: PromptDraft) => void;
  onOpenChange: (open: boolean) => void;
  /** The draft has the fields; validate and send it. */
  onSave: () => void;
}) {
  const edit = (change: Partial<PromptDraft>) => {
    if (draft) onChange({ ...draft, ...change });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{draft?.id ? "Edit prompt" : "New prompt"}</DialogTitle>
          <DialogDescription>
            {description ?? (
              <>
                A saved prompt shows up in a chat&apos;s <span className="font-mono">/</span> menu,
                so you can send it without typing it out.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <Label htmlFor="prompt-name">Name</Label>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground font-mono text-sm">/</span>
              <Input
                id="prompt-name"
                value={draft?.name ?? ""}
                maxLength={PROMPT_NAME_MAX}
                placeholder="review"
                className="font-mono"
                onChange={(event) => edit({ name: event.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt-description">Description</Label>
            <Input
              id="prompt-description"
              value={draft?.description ?? ""}
              maxLength={PROMPT_DESCRIPTION_MAX}
              placeholder="Review the staged changes"
              onChange={(event) => edit({ description: event.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt-scope">Offered in</Label>
            <Select
              value={draft?.scope ?? "any"}
              onValueChange={(value) => edit({ scope: value as PromptScope })}
            >
              <SelectTrigger id="prompt-scope" className="w-full">
                <SelectValue>{PROMPT_SCOPE_LABELS[draft?.scope ?? "any"]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PROMPT_SCOPES.map((scope) => (
                  <SelectItem key={scope} value={scope}>
                    {PROMPT_SCOPE_LABELS[scope]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt-hint">Example arguments</Label>
            <Input
              id="prompt-hint"
              value={draft?.argumentHint ?? ""}
              maxLength={PROMPT_ARGUMENT_HINT_MAX}
              placeholder="path to review, or a focus area"
              onChange={(event) => edit({ argumentHint: event.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              Shown beside the name in the <span className="font-mono">/</span> menu.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prompt-content">Prompt</Label>
            <Textarea
              id="prompt-content"
              value={draft?.content ?? ""}
              placeholder="Review the staged changes. Focus on ${1:-correctness and security}."
              className="min-h-40 text-sm"
              onChange={(event) => edit({ content: event.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              <span className="font-mono">$1</span> is the first word you type after the name,{" "}
              <span className="font-mono">$@</span> is all of it.{" "}
              <span className="font-mono">{"${1:-fallback}"}</span> covers when you type nothing.
            </p>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {draft?.id ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
