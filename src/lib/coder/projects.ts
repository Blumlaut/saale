/**
 * Coder projects: one git repo per project, inside the user's workspace.
 *
 * Creating a project is the only place the app writes a repo into a workspace.
 * The `.gitconfig` goes down first, because a commit without an identity fails
 * inside the container and the model would spend a turn discovering it; then
 * `git init` or `git clone` runs in the container; only then does the row
 * exist, so a failed clone leaves no half-project in the list to clean up.
 *
 * Every query takes `userId`, and every directory is re-checked against
 * `projects/` before git sees it, because the stored path is what reaches a
 * shell.
 */

import type { CoderProject } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeWorkspaceFile } from "@/lib/sandbox/workspace";
import { GitError, cloneRepo, initRepo, runGit } from "./git";
import { ensureGitconfig, gitIdentityFor } from "./gitconfig";
import { PROJECTS_DIR, coderWorkspaceRoot, projectRepoPath, resolveCoderPath } from "./paths";
import { isCoderSlug, repoSlugFromUrl, toCoderSlug, uniqueSlug } from "./slug";

/** Branch a fresh repo starts on, and the fallback for a detached clone. */
const DEFAULT_BRANCH = "main";

/** `CoderProject.name` is a VarChar(100). */
const MAX_NAME_LENGTH = 100;

/** Long enough for a deep forge URL, short enough to be a URL. */
const MAX_CLONE_URL_LENGTH = 2048;

/** A conflicting slug is retried this many times before giving up. */
const MAX_SLUG_ATTEMPTS = 3;

/** Worktree rows in this state count towards a project's worktrees. */
const WORKTREE_STATUS_ACTIVE = "active";

/** What a fresh repo ignores. Committed by hand; the project starts empty. */
export const DEFAULT_GITIGNORE = [
  "node_modules/",
  "dist/",
  ".env",
  ".env.*",
  "*.log",
  ".DS_Store",
  "",
].join("\n");

export interface CreateProjectInput {
  name: string;
  cloneUrl?: string | null | undefined;
  /** Clone through `gh`, which reads the user's `GH_TOKEN`. */
  authFromEnv?: boolean | undefined;
}

/** A project operation the route can report as-is. `status` is the HTTP code. */
export class CoderProjectError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "CoderProjectError";
  }
}

/** A project as the list shows it. */
export interface CoderProjectSummary {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  defaultBranch: string;
  /** Worktrees still checked out, so removed ones do not inflate it. */
  worktreeCount: number;
  chatCount: number;
  /** Newest chat activity, null for a project nothing has run in. */
  lastActivityAt: Date | null;
}

/** One chat of a project, with the worktree it runs in. */
export interface CoderProjectChat {
  id: string;
  title: string;
  lastActivityAt: Date;
  worktree: { path: string; branch: string; status: string } | null;
}

export interface CoderProjectDetail {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  defaultBranch: string;
  originUrl: string | null;
  chats: CoderProjectChat[];
}

/** One line of a name that a directory and a branch both accept. */
function cleanName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) throw new CoderProjectError("A project needs a name");
  if (cleaned.length > MAX_NAME_LENGTH) {
    throw new CoderProjectError(`A project name is at most ${MAX_NAME_LENGTH} characters`);
  }
  return cleaned;
}

/** The clone URL, refused when it is not something git can be handed. */
function cleanCloneUrl(cloneUrl: string | null | undefined): string | null {
  const url = (cloneUrl ?? "").trim();
  if (!url) return null;
  if (url.length > MAX_CLONE_URL_LENGTH) {
    throw new CoderProjectError(`A clone URL is at most ${MAX_CLONE_URL_LENGTH} characters`);
  }
  // The URL reaches a shell. shellQuote handles quoting; a control byte or a
  // newline would still make the command a different one, so it never gets in.
  if (/[\s\u0000-\u001f\u007f]/.test(url)) {
    throw new CoderProjectError("A clone URL cannot contain whitespace");
  }
  return url;
}

/** The slug a project would like, before conflicts are resolved. */
function baseSlug(name: string, cloneUrl: string | null): string {
  if (name) return toCoderSlug(name);
  return cloneUrl ? repoSlugFromUrl(cloneUrl) : "project";
}

/** The first free slug of the user's projects, read fresh each attempt. */
async function nextSlug(userId: string, base: string): Promise<string> {
  const taken = await prisma.coderProject.findMany({
    where: { userId },
    select: { slug: true },
  });
  return uniqueSlug(
    base,
    taken.map((project) => project.slug),
  );
}

/** `projects/<slug>`, refused unless the resolved path really sits there. */
function repoDirFor(userId: string, slug: string): string {
  if (!isCoderSlug(slug)) throw new CoderProjectError(`Not a project slug: ${slug}`);

  const dir = projectRepoPath(slug);
  const absolute = resolveCoderPath(userId, dir);
  if (!absolute.startsWith(`${coderWorkspaceRoot(userId)}/${PROJECTS_DIR}/`)) {
    throw new CoderProjectError(`A project must live in ${PROJECTS_DIR}/, not ${dir}`);
  }
  return dir;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Put a repo at `dir` and report the branch it tracks.
 *
 * An init gets the default `.gitignore` and no commit: an empty repo is a
 * valid starting point, and the first real commit belongs to the model.
 */
async function prepareRepo(
  userId: string,
  options: { dir: string; cloneUrl: string | null; authFromEnv: boolean },
): Promise<string> {
  if (options.cloneUrl) {
    await cloneRepo(userId, {
      dir: options.dir,
      url: options.cloneUrl,
      authFromEnv: options.authFromEnv,
    });
    const head = await runGit(userId, {
      cwd: options.dir,
      args: ["symbolic-ref", "--short", "HEAD"],
      allowFailure: true,
    });
    const branch = head.stdout.trim();
    return head.exitCode === 0 && branch ? branch : DEFAULT_BRANCH;
  }

  await initRepo(userId, { dir: options.dir, defaultBranch: DEFAULT_BRANCH });
  await writeWorkspaceFile(userId, `${options.dir}/.gitignore`, Buffer.from(DEFAULT_GITIGNORE));
  return DEFAULT_BRANCH;
}

/**
 * Create a project: `git init` when there is no URL, a clone when there is.
 *
 * A clone of a repo whose default branch is not `main` reports that branch, so
 * a chat's worktree starts from something that exists.
 */
export async function createProject(
  userId: string,
  input: CreateProjectInput,
): Promise<CoderProject> {
  const name = cleanName(input.name);
  const cloneUrl = cleanCloneUrl(input.cloneUrl);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, username: true, email: true },
  });
  if (!user) throw new CoderProjectError("No such user", 404);

  await ensureGitconfig(userId, gitIdentityFor(user));

  const base = baseSlug(name, cloneUrl);
  let repoPath = "";
  let defaultBranch = DEFAULT_BRANCH;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const slug = await nextSlug(userId, base);

    if (!repoPath) {
      repoPath = repoDirFor(userId, slug);
      try {
        defaultBranch = await prepareRepo(userId, {
          dir: repoPath,
          cloneUrl,
          authFromEnv: input.authFromEnv === true,
        });
      } catch (err) {
        if (err instanceof GitError) {
          console.error(`Failed to prepare the repo for "${name}" (${userId}):`, err);
          throw new CoderProjectError(err.message, 502);
        }
        throw err;
      }
    }

    try {
      return await prisma.coderProject.create({
        data: {
          userId,
          name,
          slug,
          repoPath,
          originUrl: cloneUrl,
          defaultBranch,
        },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error(`Failed to create the project row "${name}" (${userId}):`, err);
        throw err;
      }
      // A racing create took the slug between the read and the write. The repo
      // is already on disk, so the retry keeps it and takes the next free name.
      lastError = err;
    }
  }

  console.error(
    `Gave up creating the project row "${name}" (${userId}) after a slug conflict:`,
    lastError,
  );
  throw new CoderProjectError("Could not create the project, try that name again", 409);
}

/** The user's projects, most recently touched first. */
export async function listProjects(userId: string): Promise<CoderProjectSummary[]> {
  const projects = await prisma.coderProject.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      repoPath: true,
      defaultBranch: true,
      worktrees: { where: { status: WORKTREE_STATUS_ACTIVE }, select: { id: true } },
      _count: { select: { chats: true } },
      chats: { orderBy: { lastActivityAt: "desc" }, take: 1, select: { lastActivityAt: true } },
    },
  });

  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    repoPath: project.repoPath,
    defaultBranch: project.defaultBranch,
    worktreeCount: project.worktrees.length,
    chatCount: project._count.chats,
    lastActivityAt: project.chats[0]?.lastActivityAt ?? null,
  }));
}

/** A project and its chats, or null when it is not this user's. */
export async function getProject(
  userId: string,
  projectId: string,
): Promise<CoderProjectDetail | null> {
  const project = await prisma.coderProject.findFirst({
    where: { id: projectId, userId },
    select: {
      id: true,
      name: true,
      slug: true,
      repoPath: true,
      originUrl: true,
      defaultBranch: true,
      chats: {
        orderBy: { lastActivityAt: "desc" },
        select: {
          id: true,
          title: true,
          lastActivityAt: true,
          coderWorktree: { select: { path: true, branch: true, status: true } },
        },
      },
    },
  });
  if (!project) return null;

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    repoPath: project.repoPath,
    originUrl: project.originUrl,
    defaultBranch: project.defaultBranch,
    chats: project.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      lastActivityAt: chat.lastActivityAt,
      worktree: chat.coderWorktree,
    })),
  };
}

/** The project id when it belongs to `userId`, null otherwise. */
export async function ownedProjectId(userId: string, projectId: string): Promise<string | null> {
  const project = await prisma.coderProject.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  return project?.id ?? null;
}

/** A summary row as JSON, dates as ISO strings. */
export function serializeProject(project: CoderProjectSummary) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    repoPath: project.repoPath,
    defaultBranch: project.defaultBranch,
    worktreeCount: project.worktreeCount,
    chatCount: project.chatCount,
    lastActivityAt: project.lastActivityAt?.toISOString() ?? null,
  };
}

/** The list response body. */
export function serializeProjectList(projects: CoderProjectSummary[]) {
  return { projects: projects.map(serializeProject) };
}

/** The create response body. */
export function serializeCreatedProject(project: CoderProject) {
  return {
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      repoPath: project.repoPath,
      defaultBranch: project.defaultBranch,
    },
  };
}

/** The detail response body, with which chats are generating right now. */
export function serializeProjectDetail(
  project: CoderProjectDetail,
  generating: ReadonlySet<string>,
) {
  return {
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      repoPath: project.repoPath,
      defaultBranch: project.defaultBranch,
      originUrl: project.originUrl,
    },
    chats: project.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      lastActivityAt: chat.lastActivityAt.toISOString(),
      isGenerating: generating.has(chat.id),
      worktree: chat.worktree,
    })),
  };
}
