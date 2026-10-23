/**
 * Parsers for the git output the coder panel shows.
 *
 * Kept apart from the commands that produce it: the shapes are fiddly (NUL
 * records, a header line, numstat lines that count binaries as `-`) and a
 * parser is the one part of this that can be tested against captured output
 * without a container.
 */

/** One changed path, from `git status --porcelain=v1 -z`. */
export interface GitFileChange {
  /** Repo-relative path. The new one for a rename or copy. */
  path: string;
  /** Where a rename or copy came from. */
  originalPath: string | null;
  /** Index status letter (staged side, spot 1). */
  index: string;
  /** Worktree status letter (unstaged side, spot 2). */
  worktree: string;
}

/** A branch's position and its changed files. */
export interface GitStatus {
  /** Current branch, "" in detached HEAD. */
  branch: string;
  /** Tracking ref, "" when the branch has no upstream. */
  upstream: string;
  /** Commits not on the upstream. */
  ahead: number;
  /** Commits on the upstream that are not here. */
  behind: number;
  /** HEAD commit, "" on a repo with no commits yet. */
  head: string;
  files: GitFileChange[];
}

/** A line count for one path, from `git diff --numstat`. */
export interface GitNumstat {
  path: string;
  /** Where a rename came from, otherwise null. */
  originalPath?: string | null;
  /** null for a binary file, which git reports as `-`. */
  added: number | null;
  deleted: number | null;
}

/** One commit, from `git log` with a record separator. */
export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  /** Author date, ISO 8601. */
  date: string;
  author: string;
}

/** Separators inside one log record, none of which can appear in a subject. */
const LOG_FIELD = "\x1f";
const LOG_RECORD = "\x1e";

function isStatusRecord(record: string): boolean {
  // `XY path`: two status spots, a space, then something.
  return record.length >= 4 && record[2] === " ";
}

/**
 * Changed paths from `git status --porcelain=v1 -z`.
 *
 * A rename prints its two paths as two NUL-terminated records, new first, so a
 * record is only read as an origin while the one before it was a rename or a
 * copy.
 */
export function parsePorcelainZ(stdout: string): GitFileChange[] {
  const files: GitFileChange[] = [];
  let pending: GitFileChange | null = null;

  for (const record of stdout.split("\0")) {
    if (!record) continue;
    if (record.startsWith("## ")) continue;

    if (pending && !isStatusRecord(record)) {
      pending.originalPath = record;
      pending = null;
      continue;
    }

    if (!isStatusRecord(record)) continue;
    const change: GitFileChange = {
      path: record.slice(3),
      originalPath: null,
      index: record[0] ?? " ",
      worktree: record[1] ?? " ",
    };
    files.push(change);
    pending = change.index === "R" || change.index === "C" ? change : null;
  }

  return files;
}

/**
 * Branch, upstream and ahead/behind from the `## ` header.
 *
 * The header is the first NUL record of `status -z -b`: `## main...origin/main
 * [ahead 1, behind 2]`, `## main` with no upstream, `## HEAD (no branch)` when
 * detached, `## No commits yet on main` in a fresh repo.
 */
export function parseStatusHeader(stdout: string): Omit<GitStatus, "files" | "head"> {
  const header = stdout.split("\0")[0] ?? "";
  if (!header.startsWith("## ")) return { branch: "", upstream: "", ahead: 0, behind: 0 };

  let body = header.slice(3);
  const counts = /\s*\[([^\]]*)\]$/.exec(body)?.[1] ?? "";
  body = body.replace(/\s*\[[^\]]*\]$/, "");

  const ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);

  if (body.startsWith("No commits yet on ")) {
    return { branch: body.slice("No commits yet on ".length).trim(), upstream: "", ahead, behind };
  }
  // `...` cannot appear in a ref name, so the split is unambiguous.
  const dots = body.indexOf("...");
  if (dots === -1) return { branch: body.trim(), upstream: "", ahead, behind };
  return {
    branch: body.slice(0, dots).trim(),
    upstream: body.slice(dots + 3).trim(),
    ahead,
    behind,
  };
}

/**
 * `git diff --numstat -z` as line counts.
 *
 * A binary file reports `-` for both counts. A rename leaves the path field
 * empty and prints both paths as extra NUL records after the counts, origin
 * first, so the counts are attached to the new path.
 */
export function parseNumstat(stdout: string): GitNumstat[] {
  const entries: GitNumstat[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first === -1 || second === -1) continue;

    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    const entry: GitNumstat = {
      path,
      added: added === "-" ? null : Number(added),
      deleted: deleted === "-" ? null : Number(deleted),
    };
    if (!path) {
      const [original, renamed] = [records[index + 1], records[index + 2]];
      if (original === undefined || renamed === undefined) continue;
      entry.path = renamed;
      entry.originalPath = original;
      index += 2;
    }
    entries.push(entry);
  }
  return entries;
}

/** `git log --format=<LOG_FIELD-joined fields>` output as commits. */
export function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of stdout.split(LOG_RECORD)) {
    const line = record.trim();
    if (!line) continue;
    const [sha, shortSha, date, author, subject] = line.split(LOG_FIELD);
    if (!sha) continue;
    commits.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 8),
      date: date ?? "",
      author: author ?? "",
      subject: subject ?? "",
    });
  }
  return commits;
}

/**
 * `git worktree list --porcelain` as checkouts.
 *
 * The main worktree is listed first and has no `branch` line when it is
 * detached, so a block without one is a detached checkout rather than a parse
 * failure.
 */
export interface GitWorktreeEntry {
  path: string;
  head: string;
  /** Branch short name, "" when detached. */
  branch: string;
  /** True for the repo's own checkout, which cleanup never removes. */
  main: boolean;
  /** True when git reports it as prunable (its directory is gone). */
  prunable: boolean;
}

export function parseWorktreeList(stdout: string): GitWorktreeEntry[] {
  const worktrees: GitWorktreeEntry[] = [];
  for (const block of stdout.split("\n\n")) {
    let path = "";
    let head = "";
    let branch = "";
    let prunable = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch refs/heads/")) {
        branch = line.slice("branch refs/heads/".length).trim();
      } else if (line.startsWith("prunable")) prunable = true;
    }
    if (!path) continue;
    worktrees.push({ path, head, branch, main: worktrees.length === 0, prunable });
  }
  return worktrees;
}
