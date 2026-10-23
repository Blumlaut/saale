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

import type { CoderProject, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeWorkspaceFile } from "@/lib/sandbox/workspace";
import { GitError, cloneRepo, initRepo, runGit } from "./git";
import { ensureGitconfig, gitIdentityFor } from "./gitconfig";
import { CoderProjectError } from "./project-error";
import {
  excludeEnvFiles,
  parseEnvFiles,
  parseSetupScript,
  storedEnvFiles,
  writeEnvFiles,
  type EnvFile,
} from "./project-config";

export { CoderProjectError } from "./project-error";
import {
  PROJECTS_DIR,
  coderWorkspaceRoot,
  projectRepoPath,
  resolveCoderPath,
  workspaceDirectoryExists,
} from "./paths";
import { isCoderSlug, repoSlugFromUrl, toCoderSlug, uniqueSlug } from "./slug";

/** Branch a fresh repo starts on, and the fallback for a detached clone. */
const DEFAULT_BRANCH = "main";

/** `CoderProject.name` is a VarChar(100). */
const MAX_NAME_LENGTH = 100;

/** Long enough for a deep forge URL, short enough to be a URL. */
const MAX_CLONE_URL_LENGTH = 2048;

/** A conflicting slug is retried this many times before giving up. */
const MAX_SLUG_ATTEMPTS = 3;

const SETTINGS_SELECT = {
  id: true,
  name: true,
  slug: true,
  repoPath: true,
  defaultBranch: true,
  originUrl: true,
  envFiles: true,
  setupScript: true,
} as const;

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

/** The settings the panel edits, and what the detail response carries. */
export interface ProjectSettings {
  id: string;
  name: string;
  slug: string;
  repoPath: string;
  defaultBranch: string;
  originUrl: string | null;
  /** What every worktree of this project gets. */
  envFiles: EnvFile[];
  setupScript: string | null;
}

export interface CoderProjectDetail extends ProjectSettings {
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
 * An init commits nothing but the default `.gitignore`: git cannot create a
 * worktree from a repo with no commits at all, and a checkout without the
 * ignore file would show every `node_modules` as untracked.
 */
async function prepareRepo(
  userId: string,
  options: { dir: string; cloneUrl: string | null },
): Promise<string> {
  if (options.cloneUrl) {
    await cloneRepo(userId, { dir: options.dir, url: options.cloneUrl });
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
  // Committed here, because a worktree branches from a commit and it has to
  // carry the ignore file with it.
  await runGit(userId, { cwd: options.dir, args: ["add", "--", ".gitignore"] });
  await runGit(userId, { cwd: options.dir, args: ["commit", "-m", "Add .gitignore"] });
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
        defaultBranch = await prepareRepo(userId, { dir: repoPath, cloneUrl });
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
      ...SETTINGS_SELECT,
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
    envFiles: storedEnvFiles(project.envFiles),
    setupScript: project.setupScript,
    chats: project.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      lastActivityAt: chat.lastActivityAt,
      worktree: chat.coderWorktree,
    })),
  };
}

/** One project's settings, without its chats. Null when it is not this user's. */
export async function getProjectSettings(
  userId: string,
  projectId: string,
): Promise<ProjectSettings | null> {
  const project = await prisma.coderProject.findFirst({
    where: { id: projectId, userId },
    select: SETTINGS_SELECT,
  });
  return project ? { ...project, envFiles: storedEnvFiles(project.envFiles) } : null;
}

/** The project id when it belongs to `userId`, null otherwise. */
export async function ownedProjectId(userId: string, projectId: string): Promise<string | null> {
  const project = await prisma.coderProject.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  return project?.id ?? null;
}

/** A branch a repo could create, so a typo cannot become a checkout path. */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function cleanBranch(branch: string): string {
  const cleaned = branch.trim();
  if (
    !cleaned ||
    cleaned.length > 200 ||
    !BRANCH_NAME_PATTERN.test(cleaned) ||
    cleaned.includes("..") ||
    cleaned.endsWith("/")
  ) {
    throw new CoderProjectError(`"${branch}" is not a branch name`);
  }
  return cleaned;
}

export interface UpdateProjectInput {
  name?: string | undefined;
  defaultBranch?: string | undefined;
  envFiles?: EnvFile[] | undefined;
  setupScript?: string | null | undefined;
}

/**
 * Write the project's env files into the checkouts that already exist.
 *
 * Only missing files are written: a file that is there may have been edited by
 * the agent working in that checkout, and its version is the newer one. The
 * excludes are updated for the repo either way, so a file added later still
 * leaves the checkout clean.
 */
async function applyEnvToWorktrees(
  userId: string,
  project: { id: string; repoPath: string },
  envFiles: EnvFile[],
): Promise<void> {
  await excludeEnvFiles(userId, project.repoPath, envFiles);

  const worktrees = await prisma.coderWorktree.findMany({
    where: {
      projectId: project.id,
      status: WORKTREE_STATUS_ACTIVE,
      project: { userId },
    },
    select: { path: true },
  });

  for (const worktree of worktrees) {
    if (!(await workspaceDirectoryExists(userId, worktree.path))) continue;
    try {
      await writeEnvFiles(userId, worktree.path, envFiles, { onlyMissing: true });
    } catch (err) {
      console.error(`Failed to write the env files into ${worktree.path}:`, err);
    }
  }
}

/**
 * Change a project's settings.
 *
 * The slug, the repo directory and the existing branches are what the paths
 * are built from, so a rename changes the label only: nothing on disk moves.
 */
export async function updateProject(
  userId: string,
  projectId: string,
  input: UpdateProjectInput,
): Promise<ProjectSettings> {
  const project = await prisma.coderProject.findFirst({
    where: { id: projectId, userId },
    select: SETTINGS_SELECT,
  });
  if (!project) throw new CoderProjectError("Not found", 404);

  const name = input.name === undefined ? project.name : cleanName(input.name);
  const defaultBranch =
    input.defaultBranch === undefined ? project.defaultBranch : cleanBranch(input.defaultBranch);
  const envFiles =
    input.envFiles === undefined ? storedEnvFiles(project.envFiles) : parseEnvFiles(input.envFiles);
  const setupScript =
    input.setupScript === undefined ? project.setupScript : parseSetupScript(input.setupScript);

  const updated = await prisma.coderProject.update({
    where: { id: project.id },
    data: {
      name,
      defaultBranch,
      envFiles: envFiles as unknown as Prisma.InputJsonValue,
      setupScript,
    },
    select: SETTINGS_SELECT,
  });

  // Only a save that carried files has anything to hand the checkouts.
  if (input.envFiles !== undefined) await applyEnvToWorktrees(userId, updated, envFiles);

  return { ...updated, envFiles: storedEnvFiles(updated.envFiles) };
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
      envFiles: project.envFiles,
      setupScript: project.setupScript,
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
