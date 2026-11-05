"use client";

import { useState } from "react";
import { FileText, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { GlassPanel } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Page, PageAction, PageActions, PageScroll } from "@/components/layout/page";
import { cn, ROW_ACTION } from "@/lib/utils";
import { useAdminCollection } from "@/hooks/use-admin-collection";
import {
  EMPTY_PROMPT_DRAFT,
  PromptDialog,
  type PromptDraft,
} from "@/components/prompts/prompt-dialog";
import { PromptRow, type PromptRowData } from "@/components/prompts/prompt-row";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";

/** The prompt as the admin list receives it. */
interface SharedPrompt extends PromptRowData {
  content: string;
  updatedAt: string;
}

/**
 * The `/` commands every account can send.
 *
 * Written once here instead of on every account. An account's own prompt of the
 * same name replaces this one for that account.
 */
export function SharedPromptsSection() {
  const {
    items: prompts,
    loading,
    create,
    update,
    remove,
  } = useAdminCollection<SharedPrompt>({
    url: "/api/admin/shared-prompts",
    key: "prompts",
  });

  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SharedPrompt | null>(null);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    const body = {
      name: draft.name,
      description: draft.description,
      argumentHint: draft.argumentHint,
      scope: draft.scope,
      content: draft.content,
    };
    try {
      if (draft.id) await update(draft.id, body);
      else await create(body);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the prompt.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page className="gap-0">
      <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
        <PageActions>
          <PageAction
            icon={Plus}
            label="New prompt"
            onClick={() => {
              setError(null);
              setDraft(EMPTY_PROMPT_DRAFT);
            }}
          />
        </PageActions>

        <PageScroll>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : prompts.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-16 text-center md:px-6">
              <FileText className="text-muted-foreground/50 h-8 w-8" />
              <p className="text-muted-foreground mt-3 max-w-md text-sm">
                No shared prompts yet. Write one, and every account can send it as{" "}
                <span className="font-mono">/name</span>.
              </p>
            </div>
          ) : (
            <div>
              {prompts.map((prompt, index) => (
                <div key={prompt.id}>
                  {index > 0 && <Separator />}
                  <PromptRow
                    prompt={{ ...prompt, shared: false }}
                    actions={
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("h-8 w-8", ROW_ACTION)}
                          aria-label={`Edit /${prompt.name}`}
                          onClick={() => {
                            setError(null);
                            setDraft({
                              id: prompt.id,
                              name: prompt.name,
                              description: prompt.description,
                              argumentHint: prompt.argumentHint ?? "",
                              scope: prompt.scope,
                              content: prompt.content,
                            });
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "text-destructive hover:text-destructive h-8 w-8",
                            ROW_ACTION,
                          )}
                          aria-label={`Delete /${prompt.name}`}
                          onClick={() => setPendingDelete(prompt)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </PageScroll>
      </GlassPanel>

      <PromptDialog
        open={draft !== null}
        draft={draft}
        saving={saving}
        error={error}
        description="Every account gets this prompt in its / menu."
        onChange={setDraft}
        onOpenChange={(open) => !open && setDraft(null)}
        onSave={() => void save()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete /${pendingDelete?.name ?? "prompt"}?`}
        description="It leaves every account's / menu on their next chat. Prompts they wrote themselves of the same name stay."
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await remove(pendingDelete.id);
        }}
      />
    </Page>
  );
}
