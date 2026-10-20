/**
 * TypeScript client for the Open Terminal REST API.
 *
 * Wraps https://github.com/open-webui/open-terminal with typed methods,
 * multi-user support (X-User-Id header), and session tracking (X-Session-Id).
 */

import crypto from "crypto";

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = process.env.OPEN_TERMINAL_URL ?? "http://saale-open-terminal:8000";
const API_KEY = process.env.OPEN_TERMINAL_API_KEY;

/**
 * Derive the open-terminal Linux username from a Saale user ID.
 * Mirrors open-terminal's sanitize_username() logic.
 */
export function deriveOpenTerminalUsername(userId: string): string {
  const cleaned = userId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const name =
    cleaned.length >= 4
      ? cleaned.slice(0, 8)
      : crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
  const prefix = process.env.OPEN_TERMINAL_USER_PREFIX ?? "";
  const full = `${prefix}${name}`;
  return full[0]?.match(/[0-9]/) ? `u${full}` : full;
}

/**
 * Get the user's home directory inside the open-terminal container.
 */
export function getTerminalHomeDir(userId: string): string {
  return `/home/${deriveOpenTerminalUsername(userId)}`;
}

// Log config at startup (redacted key for security)
if (API_KEY) {
  // eslint-disable-next-line no-console
  console.log(`[terminal] OPEN_TERMINAL_URL=${BASE_URL} API_KEY=<${API_KEY.length} chars>`);
}

/**
 * Check if open-terminal is configured (API key is set).
 * Call this before using any terminal operations.
 */
export function isConfigured(): boolean {
  return !!API_KEY;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExecuteOptions {
  /** Working directory (relative to user home). */
  cwd?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Seconds to wait for completion before returning. */
  wait?: number;
  /** Return only the last N output entries. */
  tail?: number;
  /** Saale user ID. passed as X-User-Id header for multi-user isolation. */
  userId: string;
  /** Pi session ID. passed as X-Session-Id header for cwd persistence. */
  sessionId?: string;
}

export interface ExecuteResult {
  id: string;
  command: string;
  status: "running" | "done" | "killed";
  exit_code: number | null;
  output: Array<{ type: string; data: string } | string>;
  truncated: boolean;
  next_offset: number;
  log_path?: string;
}

export interface StatusOptions {
  /** Seconds to wait for the process to finish. */
  wait?: number;
  /** Number of output entries to skip. */
  offset?: number;
  /** Return only the last N output entries. */
  tail?: number;
  userId: string;
  sessionId?: string;
}

export interface ReadFileOptions {
  /** First line to return (1-indexed, inclusive). */
  startLine?: number;
  /** Last line to return (1-indexed, inclusive). */
  endLine?: number;
  userId: string;
  sessionId?: string;
}

export interface ReadFileResult {
  path: string;
  total_lines: number;
  content: string;
}

export interface ReadFileBinaryResult {
  path: string;
  mimeType: string;
  /** ArrayBuffer-backed so the bytes can be handed straight to a Response body. */
  buffer: Buffer<ArrayBuffer>;
}

export interface ListDirectoryResult {
  dir: string;
  /** Whether the container can write in this directory (absent on old builds). */
  writable?: boolean;
  entries: Array<{
    name: string;
    type: "file" | "directory";
    size: number;
    /** Epoch seconds, with sub-second precision. */
    modified: number;
    writable?: boolean;
  }>;
}

export interface GrepSearchOptions {
  /** Directory or file to search in. */
  path?: string;
  /** Use regex (default: true). */
  regex?: boolean;
  /** Case-insensitive matching. */
  caseInsensitive?: boolean;
  /** Glob patterns to include (e.g. ['*.ts']). */
  include?: string[];
  /** Return per-line matches (default: true). */
  matchPerLine?: boolean;
  /** Maximum number of matches. */
  maxResults?: number;
  userId: string;
  sessionId?: string;
}

export interface GrepSearchResult {
  query: string;
  path: string;
  matches: Array<{
    file: string;
    line: number;
    content: string;
  }>;
  truncated: boolean;
}

export interface GlobSearchOptions {
  /** Directory to search within. */
  path?: string;
  /** Glob patterns to exclude. */
  exclude?: string[];
  /** Type filter: 'file', 'directory', or 'any'. */
  type?: "file" | "directory" | "any";
  /** Maximum number of matches. */
  maxResults?: number;
  userId: string;
  sessionId?: string;
}

export interface GlobSearchResult {
  pattern: string;
  path: string;
  matches: Array<{
    path: string;
    type: "file" | "directory";
    size: number;
    modified: number;
  }>;
  truncated: boolean;
}

export interface ReplacementChunk {
  target: string;
  replacement: string;
  start_line?: number;
  end_line?: number;
  allow_multiple?: boolean;
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

function getHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function getUserHeaders(
  userId: string,
  sessionId?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-User-Id": userId,
    ...extra,
  };
  if (sessionId) {
    headers["X-Session-Id"] = sessionId;
  }
  return getHeaders(headers) as Record<string, string>;
}

// ─── Request helper ─────────────────────────────────────────────────────────

/**
 * A non-2xx response from Open Terminal.
 *
 * Callers branch on the status (e.g. a 404 while polling a command means the
 * container dropped it), so the code is a field rather than something to be
 * pattern-matched out of the message.
 */
export class TerminalApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
  ) {
    super(`Open Terminal error ${status}: ${statusText}${body ? `. ${body}` : ""}`);
    this.name = "TerminalApiError";
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...getHeaders(),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch((err) => {
      console.error("Failed to read Open Terminal error body:", err);
      return "";
    });
    throw new TerminalApiError(response.status, response.statusText, body);
  }

  // For JSON responses
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }

  // For binary responses, return as ArrayBuffer (caller handles casting)
  return (await response.arrayBuffer()) as unknown as T;
}

// ─── Execute ────────────────────────────────────────────────────────────────

/**
 * Execute a shell command.
 * POST /execute
 */
export async function executeCommand(
  command: string,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const { cwd, env, wait, tail, userId, sessionId } = options;
  const url = new URL(`${BASE_URL}/execute`);

  if (wait !== undefined) url.searchParams.append("wait", String(wait));
  if (tail !== undefined) url.searchParams.append("tail", String(tail));

  const body: Record<string, unknown> = { command };
  if (cwd) body.cwd = cwd;
  if (env) body.env = env;

  return request<ExecuteResult>(url.toString(), {
    method: "POST",
    headers: getUserHeaders(userId, sessionId),
    body: JSON.stringify(body),
  });
}

/**
 * Execute a command as Open Terminal's own account, not as a mapped user.
 *
 * A request without `X-User-Id` runs as the container's default account, which
 * provisions the per-user accounts and is therefore root-capable. That is an
 * app-side administrative identity. no tenant session may use it, and a
 * tenant's own account cannot escalate to it (a provisioned account needs a
 * password for `sudo`). Used to remove a council's sandbox account when the
 * council is deleted; see `lib/council/sandbox`.
 *
 * Single-shot: these are short administration commands, and a *polling* request
 * for one would carry an `X-User-Id` and so be answered by another identity.
 */
export async function executeContainerCommand(
  command: string,
  options: { wait?: number } = {},
): Promise<ExecuteResult> {
  const url = new URL(`${BASE_URL}/execute`);
  if (options.wait !== undefined) url.searchParams.append("wait", String(options.wait));

  return request<ExecuteResult>(url.toString(), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ command }),
  });
}

/**
 * Get command status and output.
 * GET /execute/{process_id}/status
 */
export async function getCommandStatus(
  processId: string,
  options: StatusOptions,
): Promise<ExecuteResult> {
  const { wait, offset, tail, userId, sessionId } = options;
  const url = new URL(`${BASE_URL}/execute/${encodeURIComponent(processId)}/status`);

  if (wait !== undefined) url.searchParams.append("wait", String(wait));
  if (offset !== undefined) url.searchParams.append("offset", String(offset));
  if (tail !== undefined) url.searchParams.append("tail", String(tail));

  return request<ExecuteResult>(url.toString(), {
    method: "GET",
    headers: getUserHeaders(userId, sessionId),
  });
}

/**
 * Kill a running command.
 * DELETE /execute/{process_id}
 */
export async function killCommand(
  processId: string,
  options: { userId: string; sessionId?: string; force?: boolean },
): Promise<{ status: string }> {
  const { userId, sessionId, force } = options;
  const url = new URL(`${BASE_URL}/execute/${encodeURIComponent(processId)}`);
  if (force) url.searchParams.append("force", "true");

  return request<{ status: string }>(url.toString(), {
    method: "DELETE",
    headers: getUserHeaders(userId, sessionId),
  });
}

/**
 * List running commands.
 * GET /execute
 */
export async function listCommands(options: { userId: string; sessionId?: string }): Promise<
  Array<{
    id: string;
    command: string;
    status: string;
    exit_code: number | null;
    log_path?: string;
  }>
> {
  const { userId, sessionId } = options;
  return request<
    Array<{
      id: string;
      command: string;
      status: string;
      exit_code: number | null;
      log_path?: string;
    }>
  >(`${BASE_URL}/execute`, {
    headers: getUserHeaders(userId, sessionId),
  });
}

// ─── Files ──────────────────────────────────────────────────────────────────

/**
 * Read a file. Returns text for text files, binary for images.
 * GET /files/read
 *
 * When the file is an image, the API returns raw binary with the image MIME type.
 * The caller must check the response content-type to distinguish.
 */
export async function readFile(
  filePath: string,
  options: ReadFileOptions,
): Promise<ReadFileResult | ReadFileBinaryResult> {
  const { startLine, endLine, userId, sessionId } = options;
  const url = new URL(`${BASE_URL}/files/read`);
  url.searchParams.append("path", filePath);
  if (startLine) url.searchParams.append("start_line", String(startLine));
  if (endLine) url.searchParams.append("end_line", String(endLine));

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getUserHeaders(userId, sessionId),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Open Terminal error ${response.status}: ${response.statusText}${body ? `. ${body}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";

  // Binary response (image)
  if (contentType.startsWith("image/")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      path: filePath,
      mimeType: contentType,
      buffer,
    };
  }

  // JSON response (text file)
  return response.json() as Promise<ReadFileResult>;
}

/**
 * Read a file as raw binary (any type).
 * GET /files/view
 */
export async function readFileBinary(
  filePath: string,
  options: { userId: string; sessionId?: string },
): Promise<ReadFileBinaryResult> {
  const { userId, sessionId } = options;
  const url = new URL(`${BASE_URL}/files/view`);
  url.searchParams.append("path", filePath);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getUserHeaders(userId, sessionId),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Open Terminal error ${response.status}: ${response.statusText}${body ? `. ${body}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());

  return { path: filePath, mimeType: contentType, buffer };
}

/**
 * Write a file.
 * POST /files/write
 */
export async function writeFile(
  filePath: string,
  content: string,
  options: { userId: string; sessionId?: string },
): Promise<{ path: string; size: number }> {
  const { userId, sessionId } = options;
  return request<{ path: string; size: number }>(`${BASE_URL}/files/write`, {
    method: "POST",
    headers: getUserHeaders(userId, sessionId),
    body: JSON.stringify({ path: filePath, content }),
  });
}

/**
 * Upload a binary file to the user's workspace via multipart form data.
 * POST /files/upload?directory=<dir>
 *
 * The `directory` is resolved against the user's home directory inside the
 * container (multi-user mode) and created if it does not exist. Returns the
 * absolute path of the written file as seen from inside the container.
 */
export async function uploadFile(
  fileName: string,
  content: Buffer,
  options: { directory: string; userId: string; sessionId?: string },
): Promise<{ path: string; size: number }> {
  const { directory, userId, sessionId } = options;

  const url = new URL(`${BASE_URL}/files/upload`);
  url.searchParams.append("directory", directory);

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(content)]), fileName);

  // Multipart body: fetch sets Content-Type (with the boundary) itself, so the
  // JSON content type from getHeaders() must not be sent here.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
  };
  if (userId) headers["X-User-Id"] = userId;
  if (sessionId) headers["X-Session-Id"] = sessionId;

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Open Terminal error ${response.status}: ${response.statusText}${body ? `. ${body}` : ""}`,
    );
  }

  return response.json() as Promise<{ path: string; size: number }>;
}

/**
 * List directory contents.
 * GET /files/list
 */
export async function listDirectory(
  directory: string,
  options: { userId: string; sessionId?: string },
): Promise<ListDirectoryResult> {
  const { userId, sessionId } = options;
  const url = new URL(`${BASE_URL}/files/list`);
  url.searchParams.append("directory", directory);

  return request<ListDirectoryResult>(url.toString(), {
    headers: getUserHeaders(userId, sessionId),
  });
}

/**
 * Create a directory.
 * POST /files/mkdir
 */
export async function createDirectory(
  path: string,
  options: { userId: string; sessionId?: string },
): Promise<{ path: string }> {
  const { userId, sessionId } = options;
  return request<{ path: string }>(`${BASE_URL}/files/mkdir`, {
    method: "POST",
    headers: getUserHeaders(userId, sessionId),
    body: JSON.stringify({ path }),
  });
}

/**
 * Delete a file or directory.
 * DELETE /files/delete
 */
export async function deleteFile(
  filePath: string,
  options: { userId: string; sessionId?: string },
): Promise<{ path: string; type: string }> {
  const { userId, sessionId } = options;
  const url = new URL(`${BASE_URL}/files/delete`);
  url.searchParams.append("path", filePath);

  return request<{ path: string; type: string }>(url.toString(), {
    method: "DELETE",
    headers: getUserHeaders(userId, sessionId),
  });
}

/**
 * Move/rename a file or directory.
 * POST /files/move
 */
export async function moveFile(
  source: string,
  destination: string,
  options: { userId: string; sessionId?: string },
): Promise<{ source: string; destination: string }> {
  const { userId, sessionId } = options;
  return request<{ source: string; destination: string }>(`${BASE_URL}/files/move`, {
    method: "POST",
    headers: getUserHeaders(userId, sessionId),
    body: JSON.stringify({ source, destination }),
  });
}

/**
 * Replace content in a file.
 * POST /files/replace
 */
export async function replaceFileContent(
  filePath: string,
  replacements: ReplacementChunk[],
  options: { userId: string; sessionId?: string },
): Promise<{ path: string; size: number }> {
  const { userId, sessionId } = options;
  return request<{ path: string; size: number }>(`${BASE_URL}/files/replace`, {
    method: "POST",
    headers: getUserHeaders(userId, sessionId),
    body: JSON.stringify({ path: filePath, replacements }),
  });
}

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * Search file contents (grep).
 * GET /files/grep
 */
export async function grepSearch(
  query: string,
  options: GrepSearchOptions,
): Promise<GrepSearchResult> {
  const {
    path = ".",
    regex = true,
    caseInsensitive = false,
    include,
    matchPerLine = true,
    maxResults = 50,
    userId,
    sessionId,
  } = options;

  const url = new URL(`${BASE_URL}/files/grep`);
  url.searchParams.append("query", query);
  url.searchParams.append("path", path);
  url.searchParams.append("regex", String(regex));
  url.searchParams.append("case_insensitive", String(caseInsensitive));
  url.searchParams.append("match_per_line", String(matchPerLine));
  url.searchParams.append("max_results", String(maxResults));
  if (include) url.searchParams.append("include", include.join(","));

  return request<GrepSearchResult>(url.toString(), {
    headers: getUserHeaders(userId, sessionId),
  });
}

/**
 * Search files by name (glob).
 * GET /files/glob
 */
export async function globSearch(
  pattern: string,
  options: GlobSearchOptions,
): Promise<GlobSearchResult> {
  const { path = ".", exclude, type = "any", maxResults = 50, userId, sessionId } = options;

  const url = new URL(`${BASE_URL}/files/glob`);
  url.searchParams.append("pattern", pattern);
  url.searchParams.append("path", path);
  url.searchParams.append("type", type);
  url.searchParams.append("max_results", String(maxResults));
  if (exclude) url.searchParams.append("exclude", exclude.join(","));

  return request<GlobSearchResult>(url.toString(), {
    headers: getUserHeaders(userId, sessionId),
  });
}

// ─── Health ─────────────────────────────────────────────────────────────────

/**
 * Check if the terminal is reachable.
 * GET /health (no auth required)
 */
export async function healthCheck(): Promise<{ status: string }> {
  const response = await fetch(`${BASE_URL}/health`);
  if (!response.ok) {
    throw new Error(`Open Terminal health check failed: ${response.status}`);
  }
  return response.json();
}
