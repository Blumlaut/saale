"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, ChevronLeft, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format";
import { deleteJson, fetchJson, patchJson, postJson } from "@/lib/http";
import {
  DEFAULT_NOTE_CATEGORY,
  NOTE_CATEGORIES,
  NOTE_CATEGORY_LABELS,
  noteCategoryLabel,
  type InfraNote,
  type NoteCategory,
} from "@/lib/infra/notes";
import type { InfraMachine } from "@/app/dashboard/infra/page";

interface MachineNotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machine: InfraMachine | null;
  /** Called after note changes so the machine list can refresh note counts. */
  onSuccess: () => void;
}

type CategoryFilter = "all" | NoteCategory;

export function MachineNotesDialog({
  open,
  onOpenChange,
  machine,
  onSuccess,
}: MachineNotesDialogProps) {
  const [notes, setNotes] = useState<InfraNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>("all");

  // Editor state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(DEFAULT_NOTE_CATEGORY);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<InfraNote | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Mobile: show either the list or the editor, desktop shows both
  const [mobilePane, setMobilePane] = useState<"list" | "editor">("list");

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  const editorActive = creating || selectedNote !== null;

  const loadNotes = useCallback(async () => {
    if (!machine) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchJson<{ notes: InfraNote[] }>(
        `/api/infra/machines/${machine.id}/notes`,
      );
      setNotes(data.notes ?? []);
    } catch (err) {
      console.error("Failed to load machine notes:", err);
      setLoadError(err instanceof Error ? err.message : "Failed to load notes");
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [machine]);

  useEffect(() => {
    if (open && machine) {
      setSelectedId(null);
      setCreating(false);
      setFilter("all");
      setSaveError(null);
      setDeleteTarget(null);
      setMobilePane("list");
      void loadNotes();
    }
  }, [open, machine, loadNotes]);

  const filteredNotes = useMemo(
    () => (filter === "all" ? notes : notes.filter((n) => n.category === filter)),
    [notes, filter],
  );

  const openNote = useCallback((note: InfraNote) => {
    setSelectedId(note.id);
    setCreating(false);
    setTitle(note.title);
    setCategory(note.category);
    setContent(note.content);
    setSaveError(null);
    setMobilePane("editor");
  }, []);

  const startNew = useCallback(() => {
    setSelectedId(null);
    setCreating(true);
    setTitle("");
    setCategory(DEFAULT_NOTE_CATEGORY);
    setContent("");
    setSaveError(null);
    setMobilePane("editor");
  }, []);

  const clearEditor = useCallback(() => {
    setSelectedId(null);
    setCreating(false);
    setSaveError(null);
  }, []);

  const handleSave = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!machine) return;
      setSaveError(null);
      setSaving(true);

      try {
        if (creating) {
          const data = await postJson<{ note: InfraNote }>(
            `/api/infra/machines/${machine.id}/notes`,
            { title, content, category },
          );
          setSelectedId(data.note.id);
          setCreating(false);
          await loadNotes();
        } else if (selectedId) {
          await patchJson(`/api/infra/machines/${machine.id}/notes/${selectedId}`, {
            title,
            content,
            category,
          });
          await loadNotes();
        }
        onSuccess();
      } catch (err) {
        console.error("Failed to save machine note:", err);
        setSaveError(err instanceof Error ? err.message : "Failed to save note");
      } finally {
        setSaving(false);
      }
    },
    [machine, creating, selectedId, title, content, category, loadNotes, onSuccess],
  );

  const confirmDelete = useCallback(async () => {
    if (!machine || !deleteTarget) return;
    setDeleting(true);
    try {
      await deleteJson(`/api/infra/machines/${machine.id}/notes/${deleteTarget.id}`);
      setDeleteTarget(null);
      if (selectedId === deleteTarget.id) clearEditor();
      await loadNotes();
      onSuccess();
    } catch (err) {
      console.error("Failed to delete machine note:", err);
      setSaveError(err instanceof Error ? err.message : "Failed to delete note");
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }, [machine, deleteTarget, selectedId, clearEditor, loadNotes, onSuccess]);

  if (!machine) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
          {/* Header. pinned */}
          <DialogHeader className="border-border/50 shrink-0 gap-1 border-b px-4 py-3 sm:px-5">
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Notes
            </DialogTitle>
            <DialogDescription>
              {machine.name} ({machine.username}@{machine.host})
            </DialogDescription>
          </DialogHeader>

          {/* Body. list + editor, each scrolls internally */}
          <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[15rem_minmax(0,1fr)]">
            {/* Notes list */}
            <div
              className={cn(
                "border-border/50 min-h-0 flex-col sm:border-r",
                mobilePane === "editor" ? "hidden sm:flex" : "flex",
              )}
            >
              <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
                <Select value={filter} onValueChange={(v) => v && setFilter(v as CategoryFilter)}>
                  <SelectTrigger size="sm" className="h-7 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {NOTE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {NOTE_CATEGORY_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="secondary" className="h-7 shrink-0" onClick={startNew}>
                  <Plus className="h-3.5 w-3.5" />
                  New
                </Button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {loading ? (
                  <div className="flex h-full items-center justify-center py-8">
                    <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
                  </div>
                ) : loadError ? (
                  <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                    <AlertCircle className="text-destructive h-5 w-5" />
                    <p className="text-destructive text-xs">{loadError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7"
                      onClick={() => void loadNotes()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : filteredNotes.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                    <FileText className="text-muted-foreground h-5 w-5" />
                    <p className="text-muted-foreground text-xs">
                      {notes.length === 0
                        ? "No notes yet. add the first one."
                        : "No notes in this category."}
                    </p>
                  </div>
                ) : (
                  filteredNotes.map((note, i) => (
                    <Fragment key={note.id}>
                      <button
                        type="button"
                        onClick={() => openNote(note)}
                        className={cn(
                          "hover:bg-accent/60 w-full cursor-pointer px-3 py-2.5 text-left transition-colors",
                          !creating && selectedId === note.id && "bg-accent/60",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {note.title}
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 rounded-full px-1.5 text-[10px]"
                          >
                            {noteCategoryLabel(note.category)}
                          </Badge>
                        </div>
                        <p className="text-muted-foreground mt-0.5 truncate text-xs">
                          {note.content}
                        </p>
                        <p className="text-muted-foreground/70 mt-1 text-[10px]">
                          {formatRelativeDate(note.updatedAt)}
                        </p>
                      </button>
                      {i < filteredNotes.length - 1 && <Separator className="mx-3" />}
                    </Fragment>
                  ))
                )}
              </div>
            </div>

            {/* Editor */}
            <div
              className={cn("min-h-0 flex-col", mobilePane === "list" ? "hidden sm:flex" : "flex")}
            >
              {!editorActive ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                  <FileText className="text-muted-foreground h-7 w-7" />
                  <p className="text-sm font-medium">Select a note to edit</p>
                  <p className="text-muted-foreground max-w-48 text-xs">
                    Or create a new note for the agent to use.
                  </p>
                  <Button variant="outline" size="sm" className="mt-1 h-7" onClick={startNew}>
                    <Plus className="h-3.5 w-3.5" />
                    New Note
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
                  {/* Editor toolbar */}
                  <div className="flex shrink-0 items-center gap-1.5 px-3 pt-3 sm:px-4">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 sm:hidden"
                      onClick={() => setMobilePane("list")}
                      title="Back to notes"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="console-label flex-1">
                      {creating ? "New note" : "Edit note"}
                    </span>
                    {!creating && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive h-7 px-2"
                        onClick={() => selectedNote && setDeleteTarget(selectedNote)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Delete
                      </Button>
                    )}
                  </div>

                  {/* Fields. scroll internally */}
                  <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-4">
                    {saveError && (
                      <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        {saveError}
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor="note-title">Title</Label>
                      <Input
                        id="note-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="e.g. Nginx config location"
                        required
                        className="h-9"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label>Category</Label>
                      <Select value={category} onValueChange={(v) => v && setCategory(v)}>
                        <SelectTrigger size="sm" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {NOTE_CATEGORIES.map((c) => (
                            <SelectItem key={c} value={c}>
                              {NOTE_CATEGORY_LABELS[c]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="note-content">Content</Label>
                      <Textarea
                        id="note-content"
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder="What should the agent know about this machine?"
                        required
                        className="min-h-48 resize-y text-sm"
                      />
                    </div>
                  </div>

                  {/* Footer. pinned */}
                  <DialogFooter className="border-border/50 -mx-0 -mb-0 shrink-0 rounded-none border-t p-3 sm:px-4 sm:py-3">
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-8 sm:hidden"
                      onClick={() => setMobilePane("list")}
                    >
                      Back
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="hidden h-8 sm:block"
                      onClick={clearEditor}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={saving} className="h-8">
                      {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                      {creating ? "Create Note" : "Save"}
                    </Button>
                  </DialogFooter>
                </form>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Note</AlertDialogTitle>
            <AlertDialogDescription>
              Delete &quot;{deleteTarget?.title}&quot;? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
