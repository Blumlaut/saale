"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  Folder,
  FolderGit2,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  MoreVertical,
  Pin,
  Plus,
  Settings,
  Trash2,
} from "lucide-react";
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
import { ChatRowMenu, WatcherChatBadge } from "@/components/chat/chat-list";
import { startChatSession } from "@/lib/chat-session";
import { deleteChat } from "@/lib/chat/delete-chat";
import { saveChatPin } from "@/lib/chat/pin";
import { deleteJson } from "@/lib/http";
import { formatRelativeDate } from "@/lib/format";
import { arrayOf, usePersistedState } from "@/hooks/use-persisted-state";
import { ROW_ACTION, cn } from "@/lib/utils";
import { DeleteCoderChatDialog } from "./delete-chat-dialog";
import { ProjectCreateDialog } from "./project-create-dialog";
import { ProjectSettingsSheet } from "./project-settings-sheet";
import { PullRequestBadge } from "./pull-request-badge";
import {
  useCoderChatStarter,
  useProjects,
  type CoderProjectChat,
  type CoderProjectSummary,
} from "./use-coder-data";

/** The projects the user folded away, remembered between visits. */
const COLLAPSED_KEY = "coder:collapsedProjects";

/**
 * The chat columns, on every chat row whether it has a value or not.
 *
 * indent · icon and title · branch · pull request · time · new chat · row menu.
 * A row without a branch or a pull request keeps the cell, so everything stays
 * in one line down the page.
 */
const BOARD_COLUMNS =
  "md:grid md:grid-cols-[1.75rem_minmax(0,1fr)_10rem_7rem_5rem_1.75rem_1.75rem] md:gap-3";

/** A row of the board: dense height, hover fill, the shared columns. */
const BOARD_ROW =
  "group flex min-h-10 items-center gap-2 py-2 pr-2 pl-4 transition-colors duration-150";

/** A chat starts where its project's name does, one fold column further in. */
const CHAT_ROW = "pl-10 md:pl-4";

const isString = (value: unknown): value is string => typeof value === "string";

/** What a project's line says beside its name: how much is under it. */
function projectMeta(project: CoderProjectSummary): string {
  if (project.chatCount === 0) return "no chats";
  return project.chatCount === 1 ? "1 chat" : `${project.chatCount} chats`;
}

/**
 * Coder's landing page: every project, with the chats it is working on under it.
 *
 * The board is the work in flight. A project is one foldable line, and its chats
 * hang under it with the branch they run on and the pull request that branch is
 * on, so the page answers what is moving and where it stands. Opening a chat is
 * one click; opening the project, its settings or a new chat are the buttons on
 * the line itself.
 */
export function ProjectList() {
  const router = useRouter();
  const { projects, loading, error, reload } = useProjects();
  const startChat = useCoderChatStarter();
  const [collapsed, setCollapsed] = usePersistedState<string[]>(COLLAPSED_KEY, [], {
    validate: arrayOf(isString),
  });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CoderProjectSummary | null>(null);
  const [deletingChat, setDeletingChat] = useState<CoderProjectChat | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);

  const folded = new Set(collapsed);
  const worktrees = projects.reduce((total, project) => total + project.worktreeCount, 0);

  const toggleFold = (projectId: string) => {
    setCollapsed((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    );
  };

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

  const chatRow = (project: CoderProjectSummary, chat: CoderProjectChat) => {
    const title = chat.title || "New Chat";
    return (
      <div
        key={chat.id}
        data-slot="session-row"
        className={cn(BOARD_ROW, CHAT_ROW, BOARD_COLUMNS, "hover:bg-accent/60")}
      >
        <span aria-hidden className="hidden md:block" />
        <Link
          href={`/dashboard/coder/${project.id}/${chat.id}`}
          className="flex min-w-0 items-center gap-2"
        >
          <MessageSquare className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          <span className="truncate text-sm">{title}</span>
          {chat.pinned && <Pin className="text-muted-foreground h-3 w-3 shrink-0" />}
          {chat.origin === "watcher" && <WatcherChatBadge />}
          {chat.isGenerating && (
            <Loader2
              className="text-primary h-3 w-3 shrink-0 animate-spin"
              aria-label="Generating"
            />
          )}
        </Link>
        <span
          data-slot="chat-branch"
          className="text-muted-foreground hidden truncate font-mono text-xs md:block"
        >
          {chat.worktree?.branch ?? ""}
        </span>
        <span data-slot="chat-pull-request" className="shrink-0">
          {chat.pullRequest && (
            <PullRequestBadge pullRequest={chat.pullRequest} tone="state" showState />
          )}
        </span>
        <span
          data-slot="row-time"
          className="text-muted-foreground hidden text-right text-xs tabular-nums md:block"
        >
          {formatRelativeDate(chat.lastActivityAt)}
        </span>
        {/* The new-chat column belongs to a project's own line. */}
        <span aria-hidden className="hidden md:block" />
        <span data-slot="row-actions" className="flex justify-end">
          <ChatRowMenu
            title={title}
            pinned={chat.pinned}
            onTogglePin={() => void togglePin(chat)}
            onDelete={() => setDeletingChat(chat)}
          />
        </span>
      </div>
    );
  };

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <GlassPanel className="flex h-full flex-col overflow-hidden border-0">
          <PageActions
            leading={
              <span className="console-label">
                {loading ? "loading" : `${projects.length} projects · ${worktrees} worktrees`}
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

            {projects.map((project, index) => {
              const isFolded = folded.has(project.id);
              return (
                <section
                  key={project.id}
                  data-slot="project-group"
                  className={cn(index > 0 && "border-border/30 border-t")}
                >
                  <div
                    data-slot="project-row"
                    className={cn(BOARD_ROW, BOARD_COLUMNS, "bg-muted hover:bg-accent")}
                  >
                    {/* Folding is its own control: the name beside it opens the
                        project, which is what the row has always done. */}
                    <span className="flex items-center justify-center">
                      {project.chatCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleFold(project.id)}
                          aria-expanded={!isFolded}
                          aria-label={`${isFolded ? "Unfold" : "Fold"} ${project.name}`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md"
                        >
                          <ChevronDown
                            className={cn(
                              "text-muted-foreground h-3.5 w-3.5 transition-transform",
                              isFolded && "-rotate-90",
                            )}
                          />
                        </button>
                      ) : (
                        <span aria-hidden className="h-6 w-6" />
                      )}
                    </span>
                    <Link
                      href={`/dashboard/coder/${project.id}`}
                      className="flex min-w-0 items-center gap-2"
                    >
                      <Folder className="text-muted-foreground h-4 w-4 shrink-0" />
                      <span className="truncate text-base font-semibold">{project.name}</span>
                    </Link>
                    <span
                      data-slot="project-meta"
                      className="text-muted-foreground truncate text-xs"
                    >
                      {projectMeta(project)}
                    </span>
                    <span aria-hidden className="hidden md:block" />
                    <span
                      data-slot="row-time"
                      className="text-muted-foreground hidden text-right text-xs tabular-nums md:block"
                    >
                      {project.lastActivityAt ? formatRelativeDate(project.lastActivityAt) : ""}
                    </span>
                    {/* The row's own actions sit at the end on a phone, in the
                        new-chat column on the board. */}
                    <span aria-hidden className="flex-1 md:hidden" />
                    <span className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={cn("shrink-0", ROW_ACTION)}
                        aria-label={`New chat in ${project.name}`}
                        onClick={() => startChat(project.id)}
                      >
                        <MessageSquarePlus className="h-4 w-4" />
                      </Button>
                    </span>
                    <span data-slot="row-actions" className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={(triggerProps) => (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className={cn("shrink-0", ROW_ACTION)}
                              aria-label={`Actions for ${project.name}`}
                              {...triggerProps}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          )}
                        />
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setSettingsFor(project.id)}>
                            <Settings className="mr-2 h-3.5 w-3.5" />
                            Project settings
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setDeleting(project)}
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            Delete project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  </div>

                  {!isFolded && (
                    <>
                      {project.chats.map((chat, chatIndex) => (
                        <Fragment key={chat.id}>
                          {chatRow(project, chat)}
                          {chatIndex < project.chats.length - 1 && <Separator />}
                        </Fragment>
                      ))}
                      {project.chatCount > project.chats.length && (
                        <div
                          className={cn(BOARD_ROW, CHAT_ROW, BOARD_COLUMNS, "hover:bg-accent/60")}
                        >
                          <span aria-hidden className="hidden md:block" />
                          <Link
                            href={`/dashboard/coder/${project.id}`}
                            className="text-muted-foreground hover:text-foreground min-w-0 truncate text-xs transition-colors duration-150"
                          >
                            All {project.chatCount} chats
                          </Link>
                        </div>
                      )}
                    </>
                  )}
                </section>
              );
            })}
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
