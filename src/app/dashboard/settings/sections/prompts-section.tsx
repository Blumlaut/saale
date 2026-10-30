"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2, MoreVertical, Pencil, Plus, Trash2, FileText } from "lucide-react";
import { cn, ROW_ACTION } from "@/lib/utils";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import {
  PROMPT_ARGUMENT_HINT_MAX,
  PROMPT_DESCRIPTION_MAX,
  PROMPT_NAME_MAX,
  PROMPT_SCOPES,
  PROMPT_SCOPE_LABELS,
  type PromptScope,
} from "@/lib/prompts/rules";

interface PromptRow {
  id: string;
  name: string;
  description: string;
  argumentHint: string | null;
  scope: PromptScope;
  content: string;
  updatedAt: string;
}

/** The form's state. `id` absent means a new prompt. */
interface Draft {
  id?: string;
  name: string;
  description: string;
  argumentHint: string;
  scope: PromptScope;
  content: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  description: "",
  argumentHint: "",
  scope: "any",
  content: "",
};

/**
 * The user's reusable prompts: the `/name` commands a chat offers besides the
 * built-in ones.
 */
export function PromptsSection() {
  const [prompts, setPrompts] = useState<PromptRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<PromptRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadPrompts = useCallback(async () => {
    try {
      const data = await fetchJson<{ prompts: PromptRow[] }>("/api/prompts");
      setPrompts(data.prompts ?? []);
    } catch (err) {
      console.error("Failed to load prompts:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPrompts();
  }, [loadPrompts]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        argumentHint: draft.argumentHint,
        scope: draft.scope,
        content: draft.content,
      };
      if (draft.id) await patchJson(`/api/prompts/${draft.id}`, body);
      else await postJson("/api/prompts", body);
      setDraft(null);
      await loadPrompts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the prompt.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteJson(`/api/prompts/${deleteTarget.id}`);
      setDeleteTarget(null);
      await loadPrompts();
    } catch (err) {
      console.error("Failed to delete prompt:", err);
    } finally {
      setDeleting(false);
    }
  };

  const openDraft = (prompt?: PromptRow) => {
    setError(null);
    setDraft(
      prompt
        ? {
            id: prompt.id,
            name: prompt.name,
            description: prompt.description,
            argumentHint: prompt.argumentHint ?? "",
            scope: prompt.scope,
            content: prompt.content,
          }
        : EMPTY_DRAFT,
    );
  };

  return (
    <div className="space-y-6">
      <GlassPanel>
        <GlassPanelContent className="p-0">
          <div className="px-4 pt-5 pb-4 md:px-6">
            <div className="flex items-start justify-between gap-3">
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <FileText className="h-5 w-5" />
                Prompts
              </h3>
              <Button size="sm" onClick={() => openDraft()}>
                <Plus className="mr-2 h-4 w-4" />
                New prompt
              </Button>
            </div>
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              Prompts you send as <span className="font-mono">/name</span> in a chat. A coder chat
              also offers the templates in its checkout&apos;s{" "}
              <span className="font-mono">.pi/prompts</span>.
            </p>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : prompts.length === 0 ? (
            <div className="border-border/60 mx-4 mb-4 rounded-xl border border-dashed p-8 text-center md:mx-6">
              <FileText className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                No prompts yet. Write one, then type its name in any chat.
              </p>
            </div>
          ) : (
            <div className="pb-2">
              {prompts.map((prompt, index) => (
                <div key={prompt.id}>
                  {index > 0 && <Separator />}
                  <div className="group hover:bg-accent/60 flex items-center gap-3 px-4 py-3 transition-colors duration-150 md:px-6">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm font-medium">
                          /{prompt.name}
                        </span>
                        {prompt.argumentHint ? (
                          <span className="text-muted-foreground truncate text-xs">
                            {prompt.argumentHint}
                          </span>
                        ) : null}
                        <Badge variant="secondary" className="rounded-full px-2 py-0 text-[10px]">
                          {PROMPT_SCOPE_LABELS[prompt.scope] ?? "Any chat"}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-1 truncate text-xs">
                        {prompt.description}
                      </p>
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={(triggerProps) => (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn("shrink-0", ROW_ACTION)}
                            {...triggerProps}
                          >
                            <MoreVertical />
                            <span className="sr-only">Actions for /{prompt.name}</span>
                          </Button>
                        )}
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openDraft(prompt)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteTarget(prompt)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit prompt" : "New prompt"}</DialogTitle>
            <DialogDescription>
              A saved prompt shows up in a chat&apos;s <span className="font-mono">/</span> menu, so
              you can send it without typing it out.
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
                  onChange={(e) =>
                    setDraft((current) =>
                      current ? { ...current, name: e.target.value } : current,
                    )
                  }
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
                onChange={(e) =>
                  setDraft((current) =>
                    current ? { ...current, description: e.target.value } : current,
                  )
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="prompt-scope">Offered in</Label>
              <Select
                value={draft?.scope ?? "any"}
                onValueChange={(value) =>
                  setDraft((current) =>
                    current ? { ...current, scope: value as PromptScope } : current,
                  )
                }
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
                onChange={(e) =>
                  setDraft((current) =>
                    current ? { ...current, argumentHint: e.target.value } : current,
                  )
                }
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
                onChange={(e) =>
                  setDraft((current) =>
                    current ? { ...current, content: e.target.value } : current,
                  )
                }
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
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {draft?.id ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete /{deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The prompt is removed from your `/` menu. Anything you already sent with it stays in
              the chat.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
