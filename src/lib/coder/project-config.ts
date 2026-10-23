/**
 * What a project hands to every worktree it makes.
 *
 * A worktree is its own checkout, so an untracked `.env` in the repo never
 * reaches it, and a setup script is the only way to install dependencies before
 * an agent's first command. Both live on the project row, both are written
 * before the container starts, and both are validated here so a path cannot
 * reach outside the checkout.
 */

import fs from "node:fs/promises";
import { isNotFoundError } from "@/lib/files/errors";
import { writeOwned, writeWorkspaceFile } from "@/lib/sandbox/workspace";
import { runInWorkspace, shellQuote } from "./git";
import { resolveCoderPath } from "./paths";
import { CoderProjectError } from "./project-error";

/** One file a project writes into each of its worktrees. */
export interface EnvFile {
  /** Checkout-relative, e.g. `.env.local` or `apps/web/.env`. */
  path: string;
  content: string;
}

/** Enough for a monorepo's env files, small enough to keep in a JSON column. */
export const MAX_ENV_FILES = 32;
const MAX_ENV_PATH_LENGTH = 200;
const MAX_ENV_FILE_BYTES = 64 * 1024;
const MAX_SETUP_SCRIPT_LENGTH = 20_000;

/** A setup script installs dependencies, which is never a fast command. */
export const SETUP_TIMEOUT_SECONDS = 900;

/** How much of a failed script's output the log keeps. */
const MAX_LOG_LENGTH = 2000;

/** git's own metadata, where a written file would break the checkout. */
const GIT_DIR = ".git";

/** A path a checkout can hold: relative, no climb, no git metadata. */
function cleanPath(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned) throw new CoderProjectError("An env file needs a path");
  if (cleaned.length > MAX_ENV_PATH_LENGTH) {
    throw new CoderProjectError(`An env file path is at most ${MAX_ENV_PATH_LENGTH} characters`);
  }
  if (cleaned.includes("\0")) throw new CoderProjectError("An env file path cannot contain \\0");
  if (cleaned !== raw) {
    throw new CoderProjectError(`"${cleaned}" cannot start or end with a space`);
  }
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    throw new CoderProjectError(`"${cleaned}" must be relative to the checkout`);
  }
  if (cleaned.endsWith("/")) {
    throw new CoderProjectError(`"${cleaned}" must name a file, not a directory`);
  }

  const segments = cleaned.split("/");
  if (segments.some((segment) => segment === "")) {
    throw new CoderProjectError(`"${cleaned}" has an empty path segment`);
  }
  if (segments.includes("..")) {
    throw new CoderProjectError(`"${cleaned}" cannot climb out of the checkout`);
  }
  if (segments.includes(GIT_DIR)) {
    throw new CoderProjectError(`"${cleaned}" cannot be written into ${GIT_DIR}`);
  }
  return cleaned;
}

/**
 * The env files a request asked for.
 *
 * An absent value is an empty list, so a client that only edits the setup
 * script does not have to send the files back.
 */
export function parseEnvFiles(value: unknown): EnvFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CoderProjectError("Env files must be a list");

  if (value.length > MAX_ENV_FILES) {
    throw new CoderProjectError(`A project can have at most ${MAX_ENV_FILES} env files`);
  }

  const seen = new Set<string>();
  const files = value.map((entry): EnvFile => {
    if (typeof entry !== "object" || entry === null) {
      throw new CoderProjectError("Each env file needs a path and its contents");
    }
    const { path: rawPath, content } = entry as { path?: unknown; content?: unknown };
    if (typeof rawPath !== "string") throw new CoderProjectError("An env file needs a path");
    if (typeof content !== "string") {
      throw new CoderProjectError(`The contents of ${rawPath} must be text`);
    }

    const cleaned = cleanPath(rawPath);
    if (seen.has(cleaned)) throw new CoderProjectError(`${cleaned} is listed twice`);
    seen.add(cleaned);

    if (Buffer.byteLength(content, "utf8") > MAX_ENV_FILE_BYTES) {
      throw new CoderProjectError(`${cleaned} is larger than ${MAX_ENV_FILE_BYTES / 1024}KB`);
    }
    return { path: cleaned, content };
  });

  // Sorted so the panel and the excludes read in the same order every time.
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The setup script a request asked for: null when there is nothing to run. */
export function parseSetupScript(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CoderProjectError("The setup script must be text");

  const script = value.replace(/\r\n/g, "\n").trim();
  if (!script) return null;
  if (script.includes("\0")) throw new CoderProjectError("The setup script cannot contain \\0");
  if (script.length > MAX_SETUP_SCRIPT_LENGTH) {
    throw new CoderProjectError(
      `The setup script is at most ${MAX_SETUP_SCRIPT_LENGTH} characters`,
    );
  }
  return script;
}

/** Env files as stored on the row, ignoring anything a hand edit left behind. */
export function storedEnvFiles(value: unknown): EnvFile[] {
  try {
    return parseEnvFiles(value);
  } catch (err) {
    console.warn("[coder] ignoring unreadable env files on a project:", err);
    return [];
  }
}

/**
 * Write a project's env files into a checkout.
 *
 * `onlyMissing` keeps whatever is already there: the files an existing worktree
 * holds may have been edited by the agent working in it.
 */
export async function writeEnvFiles(
  userId: string,
  dir: string,
  files: EnvFile[],
  options: { onlyMissing?: boolean } = {},
): Promise<string[]> {
  const written: string[] = [];

  for (const file of files) {
    const relative = `${dir}/${file.path}`;
    if (options.onlyMissing) {
      const exists = await fs.stat(resolveCoderPath(userId, relative)).then(
        () => true,
        (err: unknown) => {
          if (isNotFoundError(err)) return false;
          throw err;
        },
      );
      if (exists) continue;
    }
    await writeWorkspaceFile(userId, relative, Buffer.from(file.content, "utf8"));
    written.push(file.path);
  }

  return written;
}

/**
 * Keep the env files out of `git status` for every checkout of the repo.
 *
 * git reads `.git/info/exclude` for the whole repo, and a file listed there is
 * untracked-but-ignored, so a checkout with a `.env` in it still removes
 * cleanly. The repo's own `.gitignore` usually covers these; this covers the
 * repos that leave `.env` tracked-but-absent.
 */
export async function excludeEnvFiles(
  userId: string,
  repoDir: string,
  files: EnvFile[],
): Promise<void> {
  if (files.length === 0) return;
  const absolute = resolveCoderPath(userId, `${repoDir}/${GIT_DIR}/info/exclude`);
  const current = await fs.readFile(absolute, "utf8").catch((err: unknown) => {
    if (isNotFoundError(err)) return "";
    throw err;
  });

  const listed = new Set(current.split("\n").map((line) => line.trim()));
  const missing = files.map((file) => `/${file.path}`).filter((line) => !listed.has(line));
  if (missing.length === 0) return;

  const body = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`;
  await writeOwned(absolute, Buffer.from(body, "utf8"));
}

/**
 * Run a project's setup script in a new checkout.
 *
 * A failing script is reported and swallowed: the checkout exists and the agent
 * can work in it, and blocking the chat on an install nobody will fix is worse
 * than starting without it.
 */
export async function runSetupScript(
  userId: string,
  dir: string,
  script: string | null,
): Promise<boolean> {
  if (!script) return true;

  let result;
  try {
    result = await runInWorkspace(userId, {
      cwd: dir,
      command: `bash -lc ${shellQuote(script)}`,
      timeoutSeconds: SETUP_TIMEOUT_SECONDS,
    });
  } catch (err) {
    console.error(`Failed to run the setup script in ${dir} (${userId}):`, err);
    return false;
  }

  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(-MAX_LOG_LENGTH);
    console.error(`The setup script in ${dir} exited ${result.exitCode}:\n${output}`);
    return false;
  }
  return true;
}
