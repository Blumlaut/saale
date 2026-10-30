import path from "path";
import { randomUUID } from "crypto";
import { processAndStoreImage } from "@/lib/image-attachment";
import { FileNotFoundError, FileUploadError } from "@/lib/files/errors";
import { openUserFileTarget } from "@/lib/files/targets";
import { stagedUploadPath } from "@/lib/files/upload";
import { formatFileSize } from "@/lib/utils";
import {
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_IMAGE_BYTES,
  isImageMime,
} from "@/lib/chat/attachment-limits";

/**
 * Workspace-relative directory where files uploaded in chat are placed so the
 * agent's file tools can reach them under a name the user recognises.
 */
export const CHAT_UPLOADS_DIR = "uploads";

export { MAX_CHAT_FILE_BYTES, MAX_CHAT_IMAGE_BYTES, isImageMime };

/**
 * Sanitize a user-supplied file name so it cannot escape the destination
 * directory. Falls back to "file" for names that sanitize to empty
 * (e.g. "....").
 */
export function sanitizeFileName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  return base || "file";
}

/** A file the composer staged in the workspace, waiting to become an attachment. */
export interface ChatAttachmentRef {
  uploadId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/**
 * Turn a chunked upload into a chat attachment.
 *
 * Non-images are renamed into `files/` (the bytes the user sent, untouched) and
 * copied to `uploads/` under the name they gave. Images go through the sharp
 * pipeline instead, so vision token costs stay sane.
 */
export function validateChatAttachment(ref: ChatAttachmentRef): string | null {
  if (ref.size <= 0) return "File is empty";

  const ceiling = isImageMime(ref.mimeType) ? MAX_CHAT_IMAGE_BYTES : MAX_CHAT_FILE_BYTES;
  if (ref.size > ceiling) {
    return `File too large: ${formatFileSize(ref.size)}. Max: ${formatFileSize(ceiling)}`;
  }
  return null;
}

export interface StoredChatFile {
  /** Public ID for URL serving (no user leakage). */
  storageId: string;
  /** Path relative to the user workspace (e.g. "files/<uuid>-report.pdf"). */
  storagePath: string;
  /** Sanitized original file name, used for the agent workspace copy. */
  safeName: string;
  width?: number;
  height?: number;
}

export interface AdoptedChatFile {
  stored: StoredChatFile;
  /** Absolute path of the copy the agent works with. */
  agentPath: string;
}

/**
 * Adopt a staged upload as a chat attachment.
 *
 * The staged bytes are consumed: renamed into place for a file, deleted after
 * re-encoding for an image.
 */
export async function adoptChatUpload(
  userId: string,
  ref: ChatAttachmentRef,
): Promise<AdoptedChatFile> {
  const safeName = sanitizeFileName(ref.fileName);
  const { provider } = await openUserFileTarget(userId);
  const root = provider.root;
  const staged = stagedUploadPath(root, ref.uploadId);
  const agentPath = `${root}/${CHAT_UPLOADS_DIR}/${safeName}`;

  const stats = await provider.stat(staged);
  if (!stats || stats.kind !== "file") throw new FileNotFoundError(staged);
  if (stats.size !== ref.size) {
    throw new FileUploadError(`Upload incomplete: ${stats.size} of ${ref.size} bytes`);
  }

  if (isImageMime(ref.mimeType)) {
    const { buffer } = await provider.read(staged);
    const source = Buffer.from(buffer);
    const result = await processAndStoreImage(userId, source, ref.fileName, ref.mimeType, ref.size);
    await provider.remove(staged);
    await provider.write(agentPath, source);
    return {
      stored: {
        storageId: result.storageId,
        storagePath: result.storagePath,
        safeName,
        width: result.width,
        height: result.height,
      },
      agentPath,
    };
  }

  const storageId = randomUUID();
  const storagePath = `files/${storageId}-${safeName}`;
  await provider.rename(staged, `${root}/${storagePath}`);
  await provider.copy(`${root}/${storagePath}`, agentPath);

  return { stored: { storageId, storagePath, safeName }, agentPath };
}

export interface AttachmentPromptEntry {
  fileName: string;
  mimeType: string;
  /** Absolute path in the agent workspace, or null when not delivered. */
  agentPath: string | null;
}

/**
 * Build the file-reference lines appended to a user message so the model
 * knows where uploaded files live (same convention as Telegram documents).
 *
 * Example: `[File attached: report.pdf (application/pdf) at /home/user/uploads/report.pdf]`
 */
export function buildAttachmentPromptText(attachments: AttachmentPromptEntry[]): string {
  return attachments
    .map((att) => {
      const kind = isImageMime(att.mimeType) ? "Image" : "File";
      const at = att.agentPath ? ` at ${att.agentPath}` : "";
      return `[${kind} attached: ${att.fileName} (${att.mimeType})${at}]`;
    })
    .join("\n");
}

export { stripAttachmentPromptText } from "@/lib/strip-attachment-prompt";
