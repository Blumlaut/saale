import fs from "fs/promises";
import path from "path";
import type { Bot, Context } from "grammy";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { isConfigured as isTerminalConfigured, uploadFile } from "@/lib/terminal/client";

/**
 * Local fallback directory for downloaded Telegram files, used when no Open
 * Terminal is configured (the agent has no file tools in that case, so the
 * path is informational only).
 */
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/** Workspace-relative directory (under the user's home inside the container) where Telegram documents are stored */
export const TELEGRAM_FILES_DIR = "telegram_files";

/** Allowed MIME types that can be passed as images to the vision model */
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/avif",
]);

/** Max file size for Telegram downloads (20MB per Telegram API limit) */
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

/**
 * File metadata extracted from a Telegram message (photo, document, etc.).
 */
export interface TelegramFileInfo {
  /** File ID from Telegram (used to download) */
  fileId: string;
  /** Original file name (may be undefined for photos) */
  fileName?: string | undefined;
  /** MIME type (may be undefined for photos) */
  mimeType?: string | undefined;
  /** File size in bytes */
  fileSize?: number | undefined;
  /** Width of the media */
  width?: number | undefined;
  /** Height of the media */
  height?: number | undefined;
}

/**
 * Result of downloading and processing a Telegram file.
 */
export interface ProcessedFile {
  /** Base64-encoded image data (for image files) */
  imageData?: ImageContent;
  /** Path the agent can access (container path when terminal is configured, local path otherwise) */
  filePath?: string;
  /** File size in bytes (for document files) */
  size?: number;
  /** MIME type */
  mimeType: string;
  /** Original file name */
  fileName: string;
}

/**
 * Download a file from Telegram's CDN and process it.
 *
 * For image files: returns base64 data ready for the vision model.
 * For document files: saves the file and returns a path the agent can
 * actually reach:
 * - Open Terminal configured: uploaded into the user's workspace inside
 *   the container (the only filesystem the agent's file tools can see) —
 *   `filePath` is the container-absolute path.
 * - No Open Terminal: saved under UPLOADS_DIR (fallback).
 */
export async function downloadAndProcessTelegramFile(
  bot: Bot<Context>,
  userId: string,
  fileInfo: TelegramFileInfo,
): Promise<ProcessedFile> {
  // Get file info from Telegram API
  const file = await bot.api.getFile(fileInfo.fileId);

  // Download the file
  const downloadUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_TELEGRAM_FILE_BYTES) {
    throw new Error(`Telegram file too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
  }

  const mimeType = fileInfo.mimeType ?? "application/octet-stream";
  const fileName = fileInfo.fileName ?? `telegram_${file.file_id}.dat`;

  // For image files, return as base64 for the vision model
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      imageData: {
        type: "image",
        data: buffer.toString("base64"),
        mimeType,
      },
      mimeType,
      fileName,
    };
  }

  // Sanitize file name so it cannot escape the destination directory
  const safeName = path.basename(fileName.replace(/[^a-zA-Z0-9._-]/g, "_"));

  if (isTerminalConfigured()) {
    // The agent's file tools run inside the Open Terminal container — the
    // host uploads directory is invisible to them, so upload the document
    // into the container's workspace instead.
    const result = await uploadFile(safeName, buffer, {
      directory: TELEGRAM_FILES_DIR,
      userId,
    });
    return { filePath: result.path, size: result.size, mimeType, fileName };
  }

  const userDir = path.join(UPLOADS_DIR, userId, TELEGRAM_FILES_DIR);
  await fs.mkdir(userDir, { recursive: true });
  const filePath = path.join(userDir, safeName);
  await fs.writeFile(filePath, buffer);

  return { filePath, size: buffer.length, mimeType, fileName };
}

/**
 * Build a text description for a file attachment to include in the prompt.
 */
export function buildFilePromptText(
  processedFile: ProcessedFile,
  caption: string | undefined,
): string {
  const parts: string[] = [];

  if (caption) {
    parts.push(caption);
  }

  if (processedFile.imageData) {
    parts.push(`[Image attached: ${processedFile.fileName} (${processedFile.mimeType})]`);
  } else if (processedFile.filePath) {
    parts.push(
      `[File attached: ${processedFile.fileName} (${processedFile.mimeType}) at ${processedFile.filePath}]`,
    );
  }

  return parts.join(" ");
}
