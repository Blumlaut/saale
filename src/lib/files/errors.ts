/**
 * Errors the file API raises on purpose.
 *
 * Each maps to a status the browser has something useful to say about, which is
 * why they are classes rather than bare messages: the routes translate them,
 * and everything else stays a 500.
 */

/** A requested path resolved outside its root and was refused. */
export class FilePathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path is outside the workspace: ${requested}`);
    this.name = "FilePathEscapeError";
  }
}

/** The path does not exist in the workspace. */
export class FileNotFoundError extends Error {
  constructor(requested: string) {
    super(`Not found: ${requested}`);
    this.name = "FileNotFoundError";
  }
}

/** An upload would replace an existing file and overwrite was not asked for. */
export class FileConflictError extends Error {
  readonly conflicts: string[];

  constructor(conflicts: string[]) {
    super(`${conflicts.length} file(s) already exist`);
    this.name = "FileConflictError";
    this.conflicts = conflicts;
  }
}

/** A file changed on disk since the caller read it. */
export class FileModifiedError extends Error {
  constructor(name: string) {
    super(`${name} changed on disk since you opened it`);
    this.name = "FileModifiedError";
  }
}

/**
 * A chunked upload the server will not continue: a chunk that does not line up
 * with the bytes already staged, or a file that finished short of its declared
 * size.
 */
export class FileUploadError extends Error {
  readonly status: 409 | 413;

  constructor(message: string, status: 409 | 413 = 409) {
    super(message);
    this.name = "FileUploadError";
    this.status = status;
  }
}

/** A zip download would exceed a configured ceiling. */
export class FileLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLimitError";
  }
}

/** The workspace cannot be reached on this deployment (no terminal container). */
export class WorkspaceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceUnavailableError";
  }
}

/**
 * Whether an error means "this path is not there".
 *
 * Two backends answer that question in unrelated ways: the filesystem throws
 * `ENOENT`, Open Terminal answers 404 with a message rather than a code, and its
 * delete endpoint phrases it as "Path not found". Matching here keeps that
 * knowledge out of every caller.
 */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b404\b|not found|no such file/i.test(message);
}
