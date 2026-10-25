"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson, patchJson } from "@/lib/http";
import type { CoderChatMode } from "./use-coder-data";

/** One env file as the panel edits it. `key` survives a path being retyped. */
interface EnvFileDraft {
  key: number;
  path: string;
  content: string;
}

interface SettingsResponse {
  project: {
    id: string;
    name: string;
    slug: string;
    repoPath: string;
    defaultBranch: string;
    setupScript: string | null;
    envFiles: { path: string; content: string }[];
    chatMode: CoderChatMode;
  };
}

/**
 * A project's setup: what every chat's checkout starts with.
 *
 * A worktree is its own checkout, so an untracked `.env` in the repo never
 * reaches it and nothing is installed until someone asks. Both are set here,
 * once, instead of in every chat.
 */
export function ProjectSettingsSheet({
  projectId,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the server accepted a save, so the list can re-read its row. */
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [ownWorktree, setOwnWorktree] = useState(true);
  const [files, setFiles] = useState<EnvFileDraft[]>([]);
  const [script, setScript] = useState("");
  const nextKey = useRef(0);

  useEffect(() => {
    if (!open || !projectId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchJson<SettingsResponse>(`/api/coder/projects/${encodeURIComponent(projectId)}`)
      .then((data) => {
        if (cancelled) return;
        setName(data.project.name);
        setBranch(data.project.defaultBranch);
        setRepoPath(data.project.repoPath);
        setOwnWorktree(data.project.chatMode !== "repo");
        setScript(data.project.setupScript ?? "");
        setFiles(
          data.project.envFiles.map((file) => ({
            key: (nextKey.current += 1),
            path: file.path,
            content: file.content,
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error(`Failed to load coder project ${projectId}:`, err);
        setError(err instanceof Error ? err.message : "Could not load the project");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const addFile = () => {
    setFiles((current) => [...current, { key: (nextKey.current += 1), path: "", content: "" }]);
  };

  const removeFile = (key: number) => {
    setFiles((current) => current.filter((file) => file.key !== key));
  };

  const editFile = (key: number, patch: Partial<EnvFileDraft>) => {
    setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...patch } : file)));
  };

  const save = async () => {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    try {
      await patchJson<SettingsResponse>(`/api/coder/projects/${encodeURIComponent(projectId)}`, {
        name: name.trim(),
        defaultBranch: branch.trim(),
        chatMode: ownWorktree ? ("worktree" as const) : ("repo" as const),
        envFiles: files.map(({ path: filePath, content }) => ({
          path: filePath.trim(),
          content,
        })),
        setupScript: script.trim() ? script : null,
      });
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      console.error(`Failed to save the settings of ${projectId}:`, err);
      setError(err instanceof Error ? err.message : "Could not save the settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[520px] sm:max-w-none">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b px-4 pt-4 pb-3 md:px-6">
            <SheetTitle>Project settings</SheetTitle>
            <SheetDescription className="truncate text-xs">
              {repoPath || "Loading…"}
            </SheetDescription>
          </SheetHeader>

          <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b px-4 py-2 md:px-6">
              <TabsList>
                <TabsTrigger value="general">General</TabsTrigger>
                <TabsTrigger value="chats">Chats</TabsTrigger>
                <TabsTrigger value="environment">Environment</TabsTrigger>
                <TabsTrigger value="setup">Setup</TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
              {loading ? (
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Loader2 className="animate-spin" /> Loading…
                </p>
              ) : (
                <>
                  <TabsContent value="general" className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="project-name">Name</Label>
                      <Input
                        id="project-name"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={100}
                      />
                      <p className="text-muted-foreground text-xs">
                        The directory and the branches keep their slug, so renaming moves nothing on
                        disk.
                      </p>
                    </div>
                  </TabsContent>

                  <TabsContent value="chats" className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Label htmlFor="project-worktree">Own worktree per chat</Label>
                        <p className="text-muted-foreground mt-1 text-xs">
                          Every chat gets a branch and a directory of its own. Turn it off and the
                          chats run in the project&apos;s checkout, one branch for all of them.
                        </p>
                      </div>
                      <Switch
                        id="project-worktree"
                        className="mt-1"
                        checked={ownWorktree}
                        onCheckedChange={setOwnWorktree}
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="project-branch">Default branch</Label>
                      <Input
                        id="project-branch"
                        value={branch}
                        onChange={(event) => setBranch(event.target.value)}
                        className="font-mono text-xs"
                        maxLength={200}
                      />
                      <p className="text-muted-foreground text-xs">
                        What a new chat&apos;s branch starts from. Chats that already have a
                        checkout keep theirs.
                      </p>
                    </div>
                  </TabsContent>

                  <TabsContent value="environment" className="flex flex-col gap-3">
                    <p className="text-muted-foreground text-xs">
                      Written into a chat&apos;s checkout before it starts, so every chat has the
                      same keys. A checkout that already holds a file keeps its version.
                    </p>

                    {files.length === 0 && (
                      <p className="text-muted-foreground text-xs">No files yet.</p>
                    )}

                    {files.map((file) => (
                      <div
                        key={file.key}
                        className="flex flex-col gap-1.5 rounded-lg border p-2"
                        data-testid="env-file"
                      >
                        <div className="flex items-center gap-1">
                          <Input
                            aria-label="Env file path"
                            value={file.path}
                            onChange={(event) => editFile(file.key, { path: event.target.value })}
                            placeholder=".env.local"
                            className="font-mono text-xs"
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${file.path || "env file"}`}
                            onClick={() => removeFile(file.key)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                        <Textarea
                          aria-label={`Contents of ${file.path || "the env file"}`}
                          value={file.content}
                          onChange={(event) => editFile(file.key, { content: event.target.value })}
                          rows={5}
                          spellCheck={false}
                          className="font-mono text-xs"
                          placeholder="KEY=value"
                        />
                      </div>
                    ))}

                    <Button variant="outline" size="sm" className="self-start" onClick={addFile}>
                      <Plus /> Add file
                    </Button>
                  </TabsContent>

                  <TabsContent value="setup" className="flex flex-col gap-2">
                    <Label htmlFor="project-setup">Run after a checkout is made</Label>
                    <Textarea
                      id="project-setup"
                      value={script}
                      onChange={(event) => setScript(event.target.value)}
                      rows={8}
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder={"npm install\nnpm run db:generate"}
                    />
                    <p className="text-muted-foreground text-xs">
                      Runs in each new chat&apos;s checkout, with the env files already in place. A
                      failure is logged and the chat starts anyway.
                    </p>
                  </TabsContent>
                </>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t px-4 py-3 md:px-6">
              {error && (
                <p className="text-destructive text-xs break-words whitespace-pre-wrap">{error}</p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={saving || loading}>
                  {saving && <Loader2 className="animate-spin" />}
                  Save
                </Button>
              </div>
            </div>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
