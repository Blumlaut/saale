import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { isConfigured as isTerminalConfigured, uploadFile } from "@/lib/terminal/client";
import { processAndStoreImage } from "@/lib/image-attachment";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/**
 * Workspace-relative directory (under the user's home inside the Open
 * Terminal container, or under the local user dir as fallback) where files
 * uploaded in chat are placed so the agent's file tools can reach them.
 */
export const CHAT_UPLOADS_DIR = "uploads";

/** Max upload size for chat attachments: 15MB */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Check if a MIME type is an image.
 */
export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

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

/**
 * Validate an uploaded chat file.
 *
 * Any MIME type is accepted — files are stored per-user and only ever served
 * back to the same user. Only size and emptiness are enforced.
 */
export function validateChatFile(file: File): string | null {
  if (file.size === 0) {
    return "File is empty";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${(
      MAX_UPLOAD_BYTES /
      1024 /
      1024
    ).toFixed(0)}MB`;
  }
  return null;
}

export interface StoredChatFile {
  /** Public ID for URL serving (no user leakage). */
  storageId: string;
  /** Path relative to the user workspace (e.g. "files/<uuid>-report.pdf"). */
  storagePath: string;
  /** Sanitized original file name — used for the agent workspace copy. */
  safeName: string;
  width?: number;
  height?: number;
}

/**
 * Store a chat attachment in the host-side user workspace.
 *
 * - Images: re-encoded to PNG (keeps vision token costs reasonable) under
 *   `images/<uuid>.png` — the existing flow, unchanged.
 * - Other files: original bytes under `files/<uuid>-<safeName>` (the UUID
 *   prefix means re-uploading the same name never overwrites an earlier
 *   message's copy).
 */
export async function storeChatFile(
  userId: string,
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<StoredChatFile> {
  const safeName = sanitizeFileName(originalName);

  if (isImageMime(mimeType)) {
    const result = await processAndStoreImage(
      userId,
      fileBuffer,
      originalName,
      mimeType,
      fileBuffer.length,
    );
    return {
      storageId: result.storageId,
      storagePath: result.storagePath,
      safeName,
      width: result.width,
      height: result.height,
    };
  }

  const filesDir = path.join(UPLOADS_DIR, userId, "files");
  await fs.mkdir(filesDir, { recursive: true });

  const storageId = randomUUID();
  const storagePath = `files/${storageId}-${safeName}`;
  await fs.writeFile(path.join(UPLOADS_DIR, userId, storagePath), fileBuffer);

  return { storageId, storagePath, safeName };
}

/**
 * Copy an uploaded file into the agent's terminal workspace (the Open
 * Terminal container is the only filesystem the agent's file tools can see).
 *
 * Returns the absolute container path when the terminal is configured, or
 * null when it is not (the agent has no file tools in that case, so there is
 * nowhere to deliver the file). Throws when the terminal is configured but
 * the upload fails — callers should surface that to the user.
 */
export async function deliverChatFileToAgent(
  userId: string,
  fileBuffer: Buffer,
  fileName: string,
): Promise<string | null> {
  if (!isTerminalConfigured()) {
    return null;
  }

  const result = await uploadFile(fileName, fileBuffer, {
    directory: CHAT_UPLOADS_DIR,
    userId,
  });
  return result.path;
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
