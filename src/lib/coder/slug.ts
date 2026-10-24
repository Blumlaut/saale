/**
 * Names inside a workspace.
 *
 * A project slug and a worktree slug both become a directory and a git branch,
 * so they are restricted to what a shell, a filesystem and git all accept
 * without quoting: lowercase letters, digits and single dashes.
 */

/** Longest slug kept as-is; longer names are truncated before a digest. */
const MAX_SLUG_LENGTH = 60;

/** `projects/saale-web`, `worktrees/saale-web/c-1a2b3c4d`. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Longest branch name kept; git's own limit is far higher. */
const MAX_BRANCH_LENGTH = 200;

/** Branch names are slugs and slashes, nothing a shell would want quoted. */
const WORKTREE_BRANCH_PATTERN = /^[a-z0-9][a-z0-9/_-]*$/;

/** A branch name git will take without quoting. */
const BRANCH_PREFIX = "wt/";

/** Branch a coder chat's worktree is checked out on. */
export function coderBranchName(chatSlug: string): string {
  return `${BRANCH_PREFIX}${chatSlug}`;
}

/** Where a watcher's fires are checked out: one name per watcher, then the fire. */
export function watcherBranchName(watcherSlug: string, key: string): string {
  return `watch/${assertSlugish(watcherSlug)}/${assertSlugish(key)}`;
}

/**
 * A branch name this module could have produced, re-checked before git sees it.
 *
 * The value comes from a row, and a row can be edited: git refuses a branch with
 * `..` or a trailing slash, and a leading dash would read as an option.
 */
export function isWorktreeBranch(value: string): boolean {
  return (
    value.length <= MAX_BRANCH_LENGTH &&
    WORKTREE_BRANCH_PATTERN.test(value) &&
    !value.includes("..") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function assertSlugish(value: string): string {
  if (!isCoderSlug(value)) throw new Error(`Not a usable name: ${value}`);
  return value;
}

/**
 * Short, stable name for one chat's worktree.
 *
 * Chat titles are written after the first message, so a readable slug would
 * have to be renamed later, and renaming a branch under a running agent is a
 * move nobody wants. The session id is stable from creation.
 */
export function coderChatSlug(sessionId: string): string {
  const digest = sessionId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return `c-${digest.slice(0, 8) || "chat"}`;
}

/** Whether a string can be used as a project or worktree slug. */
export function isCoderSlug(value: string): boolean {
  return value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

/** A display name as a candidate slug. Never returns an empty string. */
export function toCoderSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "project";
}

/**
 * The name a clone takes when the user does not give one: the last segment of
 * the URL, without `.git`.
 *
 * Handles `https://host/owner/repo.git`, `git@host:owner/repo.git` and a plain
 * path, none of which `new URL` parses into something useful in every case.
 */
export function repoSlugFromUrl(url: string): string {
  const path = url
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  const last = path.split(/[/:]/).filter(Boolean).pop() ?? "";
  return toCoderSlug(last.replace(/\.git$/i, ""));
}

/**
 * `base`, or `base-2`, `base-3`… when the name is taken.
 *
 * Two projects in one workspace cannot share a slug (it is the directory and
 * half of a unique index), so the second "api" becomes "api-2" instead of an
 * error the user has to resolve by hand.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - 5)}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`No free slug for "${base}"`);
}
