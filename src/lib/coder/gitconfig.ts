/**
 * The workspace's git identity.
 *
 * `$HOME` inside the sandbox container is the workspace root, so one
 * `.gitconfig` there applies to every repo and worktree the user has. It is
 * written before the first project: a commit without an identity fails, and a
 * coding agent that hits that has to spend a turn discovering it.
 *
 * The file is the user's as much as Saale's: a credential helper, a URL rewrite
 * or a `commit.gpgsign` they added belongs there and outlives a deploy. So the
 * merge below only ever writes the settings named here.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { writeOwned } from "@/lib/sandbox/workspace";
import { GITCONFIG_FILE, coderWorkspaceRoot } from "./paths";

export interface GitIdentity {
  name: string;
  email: string;
}

/** One setting Saale owns in the workspace `.gitconfig`. */
export interface ManagedSetting {
  section: string;
  key: string;
  value: string;
  /** Repeated keys are legitimate: git keeps every `safe.directory`. */
  multi?: true;
}

/** Trim, and fall back rather than write an empty setting. */
function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/[\r\n\0]/g, " ").trim();
}

/**
 * The commit identity for a user.
 *
 * Their account name and email: a commit made on their behalf should be theirs,
 * and Saale has no second identity to offer.
 */
export function gitIdentityFor(user: {
  name?: string | null;
  username?: string | null;
  email: string;
}): GitIdentity {
  const email = clean(user.email) || "saale@localhost";
  const name = clean(user.name) || clean(user.username) || email.split("@")[0] || "saale";
  return { name, email };
}

/**
 * The settings Saale owns.
 *
 * `safe.directory` because the volume is written from two accounts (the app
 * creates directories, the container's user writes in them), and git refuses a
 * repo it considers to belong to someone else. `pull.ff = only` because an
 * agent that pulls into a merge commit has made a decision nobody asked for.
 */
export function managedSettings(identity: GitIdentity, workspacePath: string): ManagedSetting[] {
  return [
    { section: "user", key: "name", value: identity.name },
    { section: "user", key: "email", value: identity.email },
    { section: "init", key: "defaultBranch", value: "main" },
    { section: "pull", key: "ff", value: "only" },
    { section: "safe", key: "directory", value: workspacePath, multi: true },
    { section: "core", key: "pager", value: "cat" },
  ];
}

/** The `.gitconfig` body, for a workspace that has none yet. */
export function gitconfigBody(identity: GitIdentity, workspacePath: string): string {
  const lines = ["# written by saale"];
  let section = "";
  for (const setting of managedSettings(identity, workspacePath)) {
    if (setting.section !== section) {
      section = setting.section;
      lines.push(`[${section}]`);
    }
    lines.push(entryLine(setting));
  }
  lines.push("");
  return lines.join("\n");
}

/** `\tkey = value`, the formatting git writes itself. */
function entryLine(setting: ManagedSetting): string {
  return `\t${setting.key} = ${setting.value}`;
}

const SECTION_PATTERN = /^\s*\[([^\]\s"]+)(?:\s+"([^"]*)")?\]\s*$/;
const ENTRY_PATTERN = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;
const COMMENT_PATTERN = /^\s*[#;]/;

interface Entry {
  /** Line index in the source. */
  index: number;
  value: string;
}

/** The lines that set `setting`, in file order. */
function findEntries(lines: readonly string[], setting: ManagedSetting): Entry[] {
  const found: Entry[] = [];
  let section: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (COMMENT_PATTERN.test(line)) continue;

    const header = SECTION_PATTERN.exec(line);
    if (header) {
      // A subsection is a different key, so only a bare section matches.
      section = header[2] === undefined ? (header[1] ?? "").toLowerCase() : null;
      continue;
    }

    if (section !== setting.section.toLowerCase()) continue;
    const entry = ENTRY_PATTERN.exec(line);
    if (!entry || (entry[1] ?? "").toLowerCase() !== setting.key.toLowerCase()) continue;
    found.push({ index, value: (entry[2] ?? "true").trim() });
  }

  return found;
}

/** Index of the last line of a section, to insert a missing key after it. */
function lastLineOfSection(lines: readonly string[], name: string): number | null {
  let at: number | null = null;
  let current: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const header = SECTION_PATTERN.exec(lines[index] ?? "");
    if (header) {
      current = header[2] === undefined ? (header[1] ?? "").toLowerCase() : null;
      continue;
    }
    if (current === name.toLowerCase() && !COMMENT_PATTERN.test(lines[index] ?? "")) at = index;
  }

  return at;
}

/**
 * `existing` with Saale's settings in it.
 *
 * Everything the settings do not name is kept as it is, including a section
 * somebody added by hand, so a re-run over a merged file changes nothing.
 */
export function mergeGitconfig(existing: string, settings: readonly ManagedSetting[]): string {
  const lines = existing.split("\n");
  const removed = new Set<number>();
  const replaced = new Map<number, string>();
  const inserted = new Map<number, string[]>();
  const appended: ManagedSetting[] = [];

  const insert = (after: number, line: string): void => {
    inserted.set(after, [...(inserted.get(after) ?? []), line]);
  };

  for (const setting of settings) {
    const entries = findEntries(lines, setting);
    const wanted = entryLine(setting);

    if (entries.length === 0) {
      const anchor = lastLineOfSection(lines, setting.section);
      if (anchor === null) appended.push(setting);
      else insert(anchor, wanted);
      continue;
    }

    if (setting.multi) {
      if (!entries.some((entry) => entry.value === setting.value)) {
        const last = entries[entries.length - 1];
        if (last) insert(last.index, wanted);
      }
      continue;
    }

    const last = entries[entries.length - 1];
    if (last) {
      // The last entry is the one git reads, so the ones before it are noise.
      if (last.value !== setting.value) replaced.set(last.index, wanted);
      for (const entry of entries.slice(0, -1)) removed.add(entry.index);
    }
  }

  const out: string[] = [];
  lines.forEach((line, index) => {
    if (!removed.has(index)) out.push(replaced.get(index) ?? line);
    for (const extra of inserted.get(index) ?? []) out.push(extra);
  });

  if (appended.length > 0) {
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    let section = "";
    for (const setting of appended) {
      if (setting.section !== section) {
        section = setting.section;
        out.push(`[${section}]`);
      }
      out.push(entryLine(setting));
    }
    out.push("");
  }

  return out.join("\n");
}

/**
 * Bring the workspace `.gitconfig` up to date.
 *
 * Returns the absolute path. A file that already carries the settings is left
 * alone, and one that carries more than that keeps the rest, so this is cheap
 * enough to call before every project operation.
 */
export async function ensureGitconfig(userId: string, identity: GitIdentity): Promise<string> {
  const root = coderWorkspaceRoot(userId);
  const target = path.join(root, GITCONFIG_FILE);
  const settings = managedSettings(identity, root);

  const existing = await fs.readFile(target, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  });

  const body =
    existing === null ? gitconfigBody(identity, root) : mergeGitconfig(existing, settings);
  if (body !== existing) await writeOwned(target, Buffer.from(body, "utf8"));
  return target;
}
