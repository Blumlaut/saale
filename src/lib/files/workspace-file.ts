/**
 * Reading one file out of a user's workspace.
 *
 * `show_file` shows the file to the chat that asked for it, and a Telegram run
 * sends the same bytes on to the user's phone. Both want the file from the same
 * place. the terminal container when it is configured, the app's uploads volume
 * otherwise. so the workspace, the path rule and the size ceiling live here
 * rather than in either caller.
 *
 * A read here is not the same operation as the file browser's: `show_file` and
 * Telegram need the bytes in hand and refuse anything past what a chat can
 * deliver, so `readWorkspaceFile` is bounded and buffered. A browser download
 * only needs the path, which is what `resolveWorkspaceFile` gives it.
 */

import path from "node:path";

import { loadChatCheckout } from "@/lib/coder/checkout";

import { FileNotFoundError } from "./errors";
import { resolveMimeType } from "./mime";
import type { FileProvider } from "./provider";
import { baseName, isWithinRoot, requireWithinRoot, resolveWithinRoot } from "./paths";
import { openUserFileTarget, type OpenedFileTarget } from "./targets";

/**
 * Largest file a caller may hand to a user.
 *
 * Binding is the chat channel with the lowest ceiling. Telegram's bot upload
 * limit. because a file the web chat can show but no other channel can deliver
 * would be a `show_file` that works until the user leaves the browser. A
 * workspace read also returns the whole file as one buffer, so this is a memory
 * ceiling as much as a delivery one. A download is streamed and does not go
 * through here.
 */
export const MAX_SHARED_FILE_BYTES = 50 * 1024 * 1024;

/** A file read out of a workspace, ready to serve or upload. */
export interface WorkspaceFile {
  /** Last path segment. what a download or a Telegram document is named. */
  fileName: string;
  mimeType: string;
  size: number;
  buffer: Uint8Array<ArrayBuffer>;
}

/** A workspace file located and measured, with its bytes still on disk. */
export interface ResolvedWorkspaceFile {
  /** The workspace the file lives in. */
  provider: FileProvider;
  /** Absolute path, already confined to the workspace. */
  path: string;
  /** Last path segment. */
  fileName: string;
  mimeType: string;
  size: number;
  /** Epoch milliseconds. */
  modified: number;
}

/**
 * Find `filePath` in `userId`'s workspace without reading it.
 *
 * A download streams straight off this, so nothing that only passes the bytes
 * on has to hold them.
 */
export async function resolveWorkspaceFile(
  userId: string,
  filePath: string,
  options: { session?: string | undefined } = {},
): Promise<ResolvedWorkspaceFile> {
  const { provider, info } = await openUserFileTarget(userId);
  const absolute = await resolveSharedPath(userId, provider, info.root, filePath, options.session);

  const stat = await provider.stat(absolute);
  if (!stat) throw new FileNotFoundError(filePath);
  if (stat.kind !== "file") throw new Error(`Not a file: ${filePath}`);

  const fileName = baseName(absolute);
  return {
    provider,
    path: absolute,
    fileName,
    mimeType: resolveMimeType(fileName),
    size: stat.size,
    modified: stat.modified,
  };
}

/**
 * Read `filePath` for `userId`.
 *
 * A relative path is resolved against the chat's active worktree when `session`
 * names a coder chat, because that is the directory the agent's tools run in.
 * Anything else resolves against the user's workspace root. The bytes come
 * from the user's workspace volume, the same one the agent's tools read.
 */
export async function readWorkspaceFile(
  userId: string,
  filePath: string,
  options: { maxBytes?: number; session?: string | undefined } = {},
): Promise<WorkspaceFile> {
  const maxBytes = options.maxBytes ?? MAX_SHARED_FILE_BYTES;
  const resolved = await resolveWorkspaceFile(userId, filePath, options);

  if (resolved.size > maxBytes) {
    throw new Error(
      `File too large: ${(resolved.size / 1024 / 1024).toFixed(1)}MB. Max: ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`,
    );
  }

  const bytes = await resolved.provider.read(resolved.path);

  return {
    fileName: resolved.fileName,
    mimeType: bytes.mimeType,
    size: bytes.buffer.length,
    buffer: bytes.buffer,
  };
}

/**
 * The absolute file a shared path points at.
 *
 * The chat's worktree is tried first for relative paths: an agent that shares
 * `notes.md` means the one in the directory it works in, not a same-named file
 * at the workspace root. A checkout is stored workspace-relative, so it needs
 * the root to become a directory anything can stat. A path that is nowhere to
 * be found still resolves the root way, so a missing file reports the path the
 * caller used.
 */
async function resolveSharedPath(
  userId: string,
  provider: OpenedFileTarget["provider"],
  root: string,
  filePath: string,
  session: string | undefined,
): Promise<string> {
  if (session && !filePath.startsWith("/")) {
    const checkout = await loadChatCheckout(userId, session);
    if (checkout) {
      const dir = resolveWithinRoot(root, checkout.path);
      const candidate = dir.inside ? path.join(dir.path, filePath) : null;
      if (candidate && isWithinRoot(dir.path, candidate)) {
        const stat = await provider.stat(candidate);
        if (stat && stat.kind === "file") return candidate;
      }
    }
  }
  return requireWithinRoot(root, filePath);
}
