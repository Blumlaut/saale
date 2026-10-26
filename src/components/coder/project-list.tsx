"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderGit2, MoreVertical, Plus, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Page, PageAction, PageActions } from "@/components/layout/page";
import { Separator } from "@/components/ui/separator";
import { ForceDeleteDialog } from "@/components/shared/force-delete-dialog";
import { startCoderChat } from "@/lib/chat-session";
import { deleteJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { ROW_ACTION, cn } from "@/lib/utils";
import { ProjectCreateDialog } from "./project-create-dialog";
import { ProjectSettingsSheet } from "./project-settings-sheet";
import { useProjects, type CoderProjectSummary } from "./use-coder-data";

/** What a project row says under its name. */
function projectMeta(project: CoderProjectSummary): string {
  const chats = project.chatCount === 1 ? "1 chat" : `${project.chatCount} chats`;
  if (project.chatMode === "repo") return `${project.slug} · ${chats} · shared checkout`;
  const trees = project.worktreeCount === 1 ? "1 worktree" : `${project.worktreeCount} worktrees`;
  return `${project.slug} · ${chats} · ${trees}`;
}

/** Project list. the coder module's landing page. */
export function ProjectList() {
  const router = useRouter();
  const { projects, loading, error, reload } = useProjects();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CoderProjectSummary | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  const created = async (result: { project: { id: string }; prompt: string | null }) => {
    if (!result.prompt) {
      router.push(`/dashboard/coder/${result.project.id}`);
      return;
    }
    try {
      const chat = await startCoderChat(result.project.id, result.prompt);
      router.push(`/dashboard/coder/${result.project.id}/${chat.id}`);
    } catch (err) {
      console.error(`Failed to start the first chat of ${result.project.id}:`, err);
      router.push(`/dashboard/coder/${result.project.id}`);
    }
  };

  const remove = async (project: CoderProjectSummary, force: boolean) => {
    try {
      await deleteJson(
        `/api/coder/projects/${encodeURIComponent(project.id)}${force ? "?force=1" : ""}`,
      );
    } catch (err) {
      console.error(`Failed to delete coder project ${project.id}:`, err);
      throw err;
    }
    reload();
  };

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          <PageActions
            leading={
              <span className="console-label">
                {loading ? "loading" : `${projects.length} projects`}
              </span>
            }
          >
            <PageAction icon={Plus} label="New project" onClick={() => setCreating(true)} />
          </PageActions>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && <p className="text-destructive p-4 text-sm break-words">{error}</p>}

            {!error && !loading && projects.length === 0 && (
              <div className="flex flex-col items-center gap-3 p-6 text-center md:p-8">
                <FolderGit2 className="text-muted-foreground h-8 w-8" />
                <p className="text-sm font-medium">Set up coder mode.</p>
                <div className="text-muted-foreground max-w-md text-left text-sm">
                  <p>A project is a git repo in your workspace.</p>
                  <p className="mt-2">
                    Point it at a repo or start from nothing, decide whether each chat gets a branch
                    of its own, and give the first chat a prompt to work on. You can change all of
                    it later under the project&apos;s settings.
                  </p>
                </div>
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" />
                  Set up a project
                </Button>
              </div>
            )}

            {projects.map((project, index) => (
              <div key={project.id}>
                <div
                  className="group hover:bg-accent/60 flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors"
                  onClick={() => router.push(`/dashboard/coder/${project.id}`)}
                >
                  <FolderGit2 className="text-muted-foreground h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{project.name}</p>
                    <p className="text-muted-foreground truncate text-xs">{projectMeta(project)}</p>
                  </div>
                  <span className="text-muted-foreground hidden shrink-0 text-xs sm:block">
                    {project.lastActivityAt ? formatRelativeDate(project.lastActivityAt) : "—"}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={(triggerProps) => {
                        // The row navigates on click, so the menu keeps its own.
                        const { onClick, ...rest } = triggerProps;
                        return (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className={cn("shrink-0", ROW_ACTION)}
                            aria-label={`Actions for ${project.name}`}
                            {...rest}
                            onClick={(event) => {
                              event.stopPropagation();
                              onClick?.(event);
                            }}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        );
                      }}
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={(event) => {
                          event.stopPropagation();
                          setSettingsFor(project.id);
                        }}
                      >
                        <Settings className="mr-2 h-3.5 w-3.5" />
                        Project settings
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeleting(project);
                        }}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        Delete project
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {index < projects.length - 1 && <Separator />}
              </div>
            ))}
          </div>
        </GlassPanel>
      </div>

      <ProjectSettingsSheet
        projectId={settingsFor}
        open={settingsFor !== null}
        onOpenChange={(open) => !open && setSettingsFor(null)}
        onSaved={reload}
      />

      <ProjectCreateDialog open={creating} onOpenChange={setCreating} onCreated={created} />

      <ForceDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        description="Its chats go with it. The repo directory goes when its tree is clean and every commit is pushed."
        discard="the uncommitted work in its repo and its chats' checkouts"
        onDelete={(force) => (deleting ? remove(deleting, force) : Promise.resolve())}
      />
    </Page>
  );
}
