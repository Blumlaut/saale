"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  AlertDialogAction,
  AlertDialogCancel,
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
import { fetchJson, postJson, patchJson, deleteJson } from "@/lib/http";
import {
  Brain,
  Loader2,
  Plus,
  Search,
  Trash2,
  Pencil,
  MoreVertical,
  Tag,
  Star,
  X,
  Layers,
  Database,
} from "lucide-react";

interface Memory {
  id: string;
  collection: string;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  source: string | null;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Collection {
  name: string;
  count: number;
  avgImportance: number;
  topTags: string[];
}

const collectionColors: Record<string, string> = {
  facts: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  projects: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  people: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  preferences: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  decisions: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
};

const collectionIcons: Record<string, React.ReactNode> = {
  facts: <Database className="h-3.5 w-3.5" />,
  projects: <Layers className="h-3.5 w-3.5" />,
  people: <Star className="h-3.5 w-3.5" />,
  preferences: <Tag className="h-3.5 w-3.5" />,
  decisions: <Brain className="h-3.5 w-3.5" />,
};

const defaultCollections = ["facts", "projects", "people", "preferences", "decisions"];

function ImportanceStars({
  value,
  onChange,
  readonly,
}: {
  value: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 10 }, (_, i) => (
        <button
          key={i}
          type="button"
          disabled={readonly}
          onClick={() => onChange?.(i + 1)}
          className={`transition-colors ${readonly ? "cursor-default" : "cursor-pointer hover:scale-110"}`}
        >
          <Star
            className={`h-3.5 w-3.5 ${
              i < value
                ? "fill-amber-400 text-amber-400"
                : "text-muted-foreground/40 fill-transparent"
            }`}
          />
        </button>
      ))}
    </div>
  );
}

export function MemoriesTab() {
  // Data state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCollection, setFilterCollection] = useState<string>("all");

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editCollection, setEditCollection] = useState("");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editImportance, setEditImportance] = useState(5);
  const [editTagInput, setEditTagInput] = useState("");
  const [saving, setSaving] = useState(false);

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCollection, setNewCollection] = useState("facts");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newImportance, setNewImportance] = useState(5);
  const [newTagInput, setNewTagInput] = useState("");
  const [creating, setCreating] = useState(false);

  // Delete alert state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: "memory" | "collection";
    id: string;
    name: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Load data
  const loadMemories = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterCollection !== "all") params.set("collection", filterCollection);
    if (searchQuery.trim()) params.set("search", searchQuery.trim());
    params.set("limit", "200");

    try {
      const data = await fetchJson<{ memories: Memory[]; total: number }>(
        `/api/memories?${params}`,
      );
      setMemories(data.memories ?? []);
    } catch {
      // Ignore
    }
  }, [filterCollection, searchQuery]);

  const loadCollections = useCallback(async () => {
    try {
      const data = await fetchJson<{ collections: Collection[]; total: number }>(
        "/api/memories/collections",
      );
      setCollections(data.collections ?? []);
      setTotalCount(data.total ?? 0);
    } catch {
      // Ignore
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadMemories(), loadCollections()]);
    setLoading(false);
  }, [loadMemories, loadCollections]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Filtered collection options (include existing + any with memories)
  const allCollectionNames = useMemo(() => {
    const names = new Set<string>(defaultCollections);
    memories.forEach((m) => names.add(m.collection));
    return Array.from(names).sort();
  }, [memories]);

  // Open edit dialog
  const openEdit = (memory: Memory) => {
    setEditingMemory(memory);
    setEditTitle(memory.title);
    setEditContent(memory.content);
    setEditCollection(memory.collection);
    setEditTags([...memory.tags]);
    setEditImportance(memory.importance);
    setEditTagInput("");
    setEditOpen(true);
  };

  // Save edited memory
  const handleSaveEdit = async () => {
    if (!editingMemory) return;
    setSaving(true);
    try {
      await patchJson(`/api/memories/${editingMemory.id}`, {
        title: editTitle,
        content: editContent,
        collection: editCollection,
        tags: editTags,
        importance: editImportance,
      });
      setEditOpen(false);
      await loadData();
    } catch {
      // Ignore
    }
    setSaving(false);
  };

  // Create new memory
  const handleCreate = async () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    setCreating(true);
    try {
      await postJson("/api/memories", {
        title: newTitle.trim(),
        content: newContent.trim(),
        collection: newCollection,
        tags: newTags,
        importance: newImportance,
      });
      setCreateOpen(false);
      setNewTitle("");
      setNewContent("");
      setNewCollection("facts");
      setNewTags([]);
      setNewImportance(5);
      setNewTagInput("");
      await loadData();
    } catch {
      // Ignore
    }
    setCreating(false);
  };

  // Delete memory
  const handleDeleteMemory = async () => {
    if (!deleteTarget || deleteTarget.type !== "memory") return;
    setDeleting(true);
    try {
      await deleteJson(`/api/memories/${deleteTarget.id}`);
      await loadData();
    } catch {
      // Ignore
    }
    setDeleting(false);
    setDeleteOpen(false);
    setDeleteTarget(null);
  };

  // Delete collection
  const handleDeleteCollection = async () => {
    if (!deleteTarget || deleteTarget.type !== "collection") return;
    setDeleting(true);
    try {
      await deleteJson(`/api/memories/collections?name=${encodeURIComponent(deleteTarget.name)}`);
      if (filterCollection === deleteTarget.name) {
        setFilterCollection("all");
      }
      await loadData();
    } catch {
      // Ignore
    }
    setDeleting(false);
    setDeleteOpen(false);
    setDeleteTarget(null);
  };

  // Tag helpers
  const addTag = (
    tags: string[],
    setTags: (v: string[]) => void,
    input: string,
    setInput: (v: string) => void,
  ) => {
    const trimmed = input.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setInput("");
  };

  const removeTag = (tags: string[], setTags: (v: string[]) => void, tag: string) => {
    setTags(tags.filter((t) => t !== tag));
  };

  return (
    <>
      <GlassPanel className="liquid-glass border-0 bg-transparent">
        <GlassPanelContent className="space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-medium">
                <Brain className="h-5 w-5" />
                Memories
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                Knowledge extracted from your conversations
                {totalCount > 0
                  ? ` — ${totalCount} memories in ${collections.length} collections`
                  : ""}
              </p>
            </div>
            <Button
              size="sm"
              className="liquid-glass-accent rounded-full"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Memory
            </Button>
          </div>

          {/* Collections overview */}
          {collections.length > 0 && (
            <div className="liquid-glass-inner rounded-2xl border-0 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium">
                <Layers className="text-muted-foreground h-4 w-4" />
                Collections
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
                {collections.map((col) => (
                  <div
                    key={col.name}
                    className="group/col liquid-glass-inner relative flex flex-col items-start justify-between rounded-xl border-0 p-3"
                  >
                    <div className="flex w-full items-start justify-between">
                      <div className="flex items-center gap-1.5">
                        {collectionIcons[col.name] || <Database className="h-3.5 w-3.5" />}
                        <span className="text-sm font-medium capitalize">{col.name}</span>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <span className="opacity-0 transition-opacity group-hover/col:opacity-100">
                              <MoreVertical className="h-3.5 w-3.5" />
                            </span>
                          }
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setFilterCollection(col.name);
                            }}
                          >
                            <Search className="mr-2 h-3.5 w-3.5" />
                            Filter to {col.name}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              setDeleteTarget({ type: "collection", id: col.name, name: col.name })
                            }
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            Delete Collection
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-2 w-full">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground text-xs">{col.count} memories</span>
                        <ImportanceStars value={Math.round(col.avgImportance)} readonly />
                      </div>
                      {col.topTags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {col.topTags.slice(0, 4).map((tag) => (
                            <Badge
                              key={tag}
                              variant="secondary"
                              className="rounded-full px-1.5 py-0 text-[10px]"
                            >
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search memories..."
                className="pl-9"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute top-1/2 right-3 -translate-y-1/2"
                >
                  <X className="text-muted-foreground h-4 w-4" />
                </button>
              )}
            </div>
            <Select value={filterCollection} onValueChange={(v) => v && setFilterCollection(v)}>
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Collections</SelectItem>
                {allCollectionNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    <span className="capitalize">{name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Memories list */}
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
            </div>
          ) : memories.length === 0 ? (
            <div className="liquid-glass-inner flex flex-col items-center rounded-2xl border border-dashed p-8 text-center">
              <Brain className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-3 text-sm">
                {searchQuery || filterCollection !== "all"
                  ? "No memories match your filters."
                  : "No memories yet. They are automatically extracted from your conversations."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {memories.map((memory) => (
                <div
                  key={memory.id}
                  className="group liquid-glass-inner flex items-start justify-between gap-3 rounded-2xl border-0 p-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className={`shrink-0 rounded-full px-2 py-0 text-xs capitalize ${
                          collectionColors[memory.collection] || "bg-muted/50"
                        }`}
                      >
                        {memory.collection}
                      </Badge>
                      <span className="truncate text-sm font-medium">{memory.title}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                      {memory.content}
                    </p>
                    <div className="mt-2 flex items-center gap-3">
                      {memory.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {memory.tags.map((tag) => (
                            <Badge
                              key={tag}
                              variant="secondary"
                              className="rounded-full px-1.5 py-0 text-[10px]"
                            >
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <ImportanceStars value={memory.importance} readonly />
                      <span className="text-muted-foreground text-[10px]">
                        {new Date(memory.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(memory)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          setDeleteTarget({ type: "memory", id: memory.id, name: memory.title })
                        }
                        className="text-destructive focus:text-destructive"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
        </GlassPanelContent>
      </GlassPanel>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Memory</DialogTitle>
            <DialogDescription>Update the details of this memory.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Memory title..."
              />
            </div>

            <div className="space-y-2">
              <Label>Content</Label>
              <Textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="Memory content..."
                rows={4}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Collection</Label>
                <Select value={editCollection} onValueChange={(v) => v && setEditCollection(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allCollectionNames.map((name) => (
                      <SelectItem key={name} value={name}>
                        <span className="capitalize">{name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Importance</Label>
                <ImportanceStars value={editImportance} onChange={setEditImportance} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-1.5">
                {editTags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="rounded-full px-2 py-0.5">
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(editTags, setEditTags, tag)}
                      className="ml-1"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={editTagInput}
                  onChange={(e) => setEditTagInput(e.target.value)}
                  placeholder="Add a tag..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag(editTags, setEditTags, editTagInput, setEditTagInput);
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => addTag(editTags, setEditTags, editTagInput, setEditTagInput)}
                >
                  Add
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={saving || !editTitle.trim() || !editContent.trim()}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Memory</DialogTitle>
            <DialogDescription>Create a new memory entry.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Memory title..."
              />
            </div>

            <div className="space-y-2">
              <Label>Content</Label>
              <Textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Memory content..."
                rows={4}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Collection</Label>
                <Select value={newCollection} onValueChange={(v) => v && setNewCollection(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {defaultCollections.map((name) => (
                      <SelectItem key={name} value={name}>
                        <span className="capitalize">{name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Importance</Label>
                <ImportanceStars value={newImportance} onChange={setNewImportance} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-1.5">
                {newTags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="rounded-full px-2 py-0.5">
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(newTags, setNewTags, tag)}
                      className="ml-1"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  placeholder="Add a tag..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag(newTags, setNewTags, newTagInput, setNewTagInput);
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => addTag(newTags, setNewTags, newTagInput, setNewTagInput)}
                >
                  Add
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !newTitle.trim() || !newContent.trim()}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.type === "memory" ? "Delete Memory" : "Delete Collection"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "memory"
                ? `Delete "${deleteTarget.name}"? This cannot be undone.`
                : `Delete the "${deleteTarget?.name}" collection and all its memories? This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={
                deleteTarget?.type === "memory" ? handleDeleteMemory : handleDeleteCollection
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
            >
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
