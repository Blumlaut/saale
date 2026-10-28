"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bot,
  FolderGit2,
  Loader2,
  MessageSquarePlus,
  MoreVertical,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { ChatListRow } from "@/components/chat/chat-list";
import { startChatSession } from "@/lib/chat-session";
import { deleteChat } from "@/lib/chat/delete-chat";
import { saveChatPin } from "@/lib/chat/pin";
import { deleteJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { ROW_ACTION, cn } from "@/lib/utils";
import { DeleteCoderChatDialog } from "./delete-chat-dialog";
import { ProjectCreateDialog } from "./project-create-dialog";
import { ProjectSettingsSheet } from "./project-settings-sheet";
import {
  useCoderChatStarter,
  useProjects,
  type CoderProjectChat,
  type CoderProjectSummary,
} from "./use-coder-data";

/** What a project row says under its name. */
function projectMeta(project: CoderProjectSummary): string {
  const chats = project.chatCount === 1 ? "1 chat" : `${project.chatCount} chats`;
  if (project.chatMode === "repo") return `${project.slug} · ${chats} · shared checkout`;
  const trees = project.worktreeCount === 1 ? "1 worktree" : `${project.worktreeCount} worktrees`;
  return `${project.slug} · ${chats} · ${trees}`;
}

/**
 * Project list. the coder module's landing page.
 *
 * Each project carries its latest chats under it, so the two clicks it used to
 * take to reopen the work you were doing are one. The project row itself is
 * still the way to the worktree panel, the settings and the rest of the chats.
 */
export function ProjectList() {
  const router = useRouter();
  const { projects, loading, error, reload } = useProjects();
  const startChat = useCoderChatStarter();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CoderProjectSummary | null>(null);
  const [deletingChat, setDeletingChat] = useState<CoderProjectChat | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  const created = async (result: { project: { id: string }; prompt: string | null }) => {
    if (!result.prompt) {
      router.push(`/dashboard/coder/${result.project.id}`);
      return;
    }
    try {
      const chat = await startChatSession({
        projectId: result.project.id,
        message: result.prompt,
      });
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

  const togglePin = async (chat: CoderProjectChat) => {
    try {
      await saveChatPin(chat.id, !chat.pinned);
    } catch (err) {
      console.error(`Failed to ${chat.pinned ? "unpin" : "pin"} coder chat ${chat.id}:`, err);
    }
  };

  const foldChats = (project: CoderProjectSummary) => (
    <div className="border-border/40 ml-8 border-l">
      {project.chats.map((chat) => (
        <ChatListRow
          key={chat.id}
          title={chat.title || "New Chat"}
          href={`/dashboard/coder/${project.id}/${chat.id}`}
          pinned={chat.pinned}
          accessories={
            <>
              {/* Opened by a watcher fire rather than by a person. */}
              {chat.origin === "watcher" && (
                <Badge variant="secondary" className="shrink-0 gap-1 px-1.5 py-0 text-[10px]">
                  <Bot className="h-3 w-3" />
                  Bot
                </Badge>
              )}
              {chat.isGenerating && (
                <Loader2 className="text-primary h-3 w-3 shrink-0 animate-spin" />
              )}
            </>
          }
          subtitle={
            <>
              <span className="shrink-0">{formatRelativeDate(chat.lastActivityAt)}</span>
              {chat.worktree && (
                <span className="truncate text-[11px]">{chat.worktree.branch}</span>
              )}
            </>
          }
          onTogglePin={() => togglePin(chat)}
          onDelete={() => setDeletingChat(chat)}
        />
      ))}
      {project.chatCount > project.chats.length && (
        <Link
          href={`/dashboard/coder/${project.id}`}
          className="text-muted-foreground hover:text-foreground flex items-center px-3 py-2 text-xs transition-colors"
        >
          All {project.chatCount} chats
        </Link>
      )}
    </div>
  );

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
                  data-slot="project-row"
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("shrink-0", ROW_ACTION)}
                    aria-label={`New chat in ${project.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      startChat(project.id);
                    }}
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </Button>
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

                {project.chats.length > 0 && foldChats(project)}

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

      <DeleteCoderChatDialog
        chat={deletingChat}
        onCancel={() => setDeletingChat(null)}
        onDelete={async (chat, force) => {
          try {
            await deleteChat(chat.id, force);
          } catch (err) {
            console.error(`Failed to delete coder chat ${chat.id}:`, err);
            throw err;
          }
        }}
      />

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
