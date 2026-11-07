"use client";

import { useCallback, useEffect, useState } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Plus, FileText } from "lucide-react";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import {
  EMPTY_PROMPT_DRAFT,
  PromptDialog,
  type PromptDraft,
} from "@/components/prompts/prompt-dialog";
import { PromptRow, type PromptRowData } from "@/components/prompts/prompt-row";
import { PromptRowActions } from "@/components/prompts/prompt-row-actions";

/** The prompt as the user's list receives it. */
interface PromptItem extends PromptRowData {
  content: string;
  updatedAt: string;
}

/**
 * The account's reusable prompts, and the ones the instance offers.
 *
 * The instance's are read-only: an admin writes them for everyone, so a user can
 * see where a `/name` came from but cannot edit or delete it.
 */
export function PromptsSection() {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<PromptItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadPrompts = useCallback(async () => {
    try {
      const data = await fetchJson<{ prompts: PromptItem[] }>("/api/prompts");
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

  const openDraft = (prompt?: PromptItem) => {
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
        : EMPTY_PROMPT_DRAFT,
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
              <span className="font-mono">.pi/prompts</span>. The shared ones come from your
              workspace and are read-only here.
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
                  <PromptRow
                    prompt={prompt}
                    actions={
                      prompt.shared ? null : (
                        <PromptRowActions
                          name={prompt.name}
                          onEdit={() => openDraft(prompt)}
                          onDelete={() => setDeleteTarget(prompt)}
                        />
                      )
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      <PromptDialog
        open={draft !== null}
        draft={draft}
        saving={saving}
        error={error}
        onChange={setDraft}
        onOpenChange={(open) => !open && setDraft(null)}
        onSave={() => void save()}
      />

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
