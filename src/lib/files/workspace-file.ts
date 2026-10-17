/**
 * Reading one file out of a user's workspace.
 *
 * `show_file` shows the file to the chat that asked for it, and a Telegram run
 * sends the same bytes on to the user's phone. Both want the file from the same
 * place — the terminal container when it is configured, the app's uploads volume
 * otherwise — so the workspace, the path rule and the size ceiling live here
 * rather than in either caller.
 *
 * The read is not the same operation as the file browser's: a browser streams
 * what the user asked for, while this happens in the middle of an agent run and
 * has to refuse anything past what a chat can actually deliver.
 */

import { FileNotFoundError } from "./errors";
import { baseName, requireWithinRoot } from "./paths";
import { openUserFileTarget } from "./targets";

/**
 * Largest file a caller may hand to a user.
 *
 * Binding is the chat channel with the lowest ceiling — Telegram's bot upload
 * limit — because a file the web chat can show but no other channel can deliver
 * would be a `show_file` that works until the user leaves the browser. A
 * workspace read also returns the whole file as one buffer, so this is a memory
 * ceiling as much as a delivery one.
 */
export const MAX_SHARED_FILE_BYTES = 50 * 1024 * 1024;

/** A file read out of a workspace, ready to serve or upload. */
export interface WorkspaceFile {
  /** Last path segment — what a download or a Telegram document is named. */
  fileName: string;
  mimeType: string;
  size: number;
  buffer: Uint8Array<ArrayBuffer>;
}

/**
 * Read `filePath`, relative to `userId`'s workspace root.
 *
 * `sessionId` is passed through to Open Terminal so its own log names the chat
 * the read came from.
 */
export async function readWorkspaceFile(
  userId: string,
  filePath: string,
  options: { sessionId?: string; maxBytes?: number } = {},
): Promise<WorkspaceFile> {
  const maxBytes = options.maxBytes ?? MAX_SHARED_FILE_BYTES;
  const { provider, info } = await openUserFileTarget(
    userId,
    options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  );
  const absolute = requireWithinRoot(info.root, filePath);

  const stat = await provider.stat(absolute);
  if (!stat) throw new FileNotFoundError(filePath);
  if (stat.kind !== "file") throw new Error(`Not a file: ${filePath}`);

  if (stat.size > maxBytes) {
    throw new Error(
      `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB. Max: ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`,
    );
  }

  const bytes = await provider.read(absolute);

  return {
    fileName: baseName(absolute),
    mimeType: bytes.mimeType,
    size: bytes.buffer.length,
    buffer: bytes.buffer,
  };
}
