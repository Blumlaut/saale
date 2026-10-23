"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderGit2, Loader2, MoreVertical, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GlassPanel } from "@/components/ui/glass-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Page } from "@/components/layout/page";
import { Separator } from "@/components/ui/separator";
import { deleteJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { ROW_ACTION, cn } from "@/lib/utils";
import { ProjectCreateDialog } from "./project-create-dialog";
import { useProjects, type CoderProjectSummary } from "./use-coder-data";

/** What a project row says under its name. */
function projectMeta(project: CoderProjectSummary): string {
  const chats = project.chatCount === 1 ? "1 chat" : `${project.chatCount} chats`;
  const trees = project.worktreeCount === 1 ? "1 worktree" : `${project.worktreeCount} worktrees`;
  return `${project.slug} · ${chats} · ${trees}`;
}

/** Project list. the coder module's landing page. */
export function ProjectList() {
  const router = useRouter();
  const { projects, loading, error, reload } = useProjects();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CoderProjectSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [forcePending, setForcePending] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async (project: CoderProjectSummary, force = false) => {
    setBusy(true);
    setDeleteError(null);
    setForcePending(false);
    try {
      await deleteJson(
        `/api/coder/projects/${encodeURIComponent(project.id)}${force ? "?force=1" : ""}`,
      );
      setDeleting(null);
      reload();
    } catch (err) {
      console.error(`Failed to delete coder project ${project.id}:`, err);
      const message = err instanceof Error ? err.message : "Could not delete the project.";
      if (!force && /modified or untracked/i.test(message)) {
        setForcePending(true);
        setDeleteError(message);
      } else {
        setDeleteError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
            <span className="console-label">
              {loading ? "loading" : `${projects.length} projects`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                className="h-8 w-8 md:w-auto md:px-3"
                onClick={() => setCreating(true)}
              >
                <Plus className="h-4 w-4" />
                <span className="hidden md:inline">New project</span>
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && <p className="text-destructive p-4 text-sm break-words">{error}</p>}

            {!error && !loading && projects.length === 0 && (
              <div className="flex flex-col items-center gap-3 p-8 text-center">
                <FolderGit2 className="text-muted-foreground h-8 w-8" />
                <p className="text-sm font-medium">No projects yet.</p>
                <p className="text-muted-foreground max-w-sm text-sm">
                  A project is a git repo in your workspace.
                </p>
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" />
                  New project
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
                        variant="destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeleting(project);
                          setDeleteError(null);
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

      <ProjectCreateDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(project) => router.push(`/dashboard/coder/${project.id}`)}
      />

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its chats go with it. The repo directory goes when its tree is clean and every commit
              is pushed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p className="text-destructive text-sm break-words whitespace-pre-wrap">
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                if (deleting) void remove(deleting, forcePending);
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {forcePending ? "Delete anyway" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
