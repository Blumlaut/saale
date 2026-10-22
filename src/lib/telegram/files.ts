import path from "path";
import type { Bot, Context } from "grammy";
import type { ImageContent } from "@earendil-works/pi-ai/compat";
import { SHOW_FILE_TOOL_NAME } from "@/lib/pi/tools/chat-tools";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { writeWorkspaceFile } from "@/lib/sandbox/workspace";
import { sendTelegramFile } from "./client";

/** Workspace-relative directory where Telegram documents are stored */
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
 * For document files: saves the file into the user's workspace and returns the
 * absolute path, which is the same string the agent's tools and the container
 * see.
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

  const filePath = await writeWorkspaceFile(userId, `${TELEGRAM_FILES_DIR}/${safeName}`, buffer);

  return { filePath, size: buffer.length, mimeType, fileName };
}

/**
 * Build a text description for a file attachment to include in the prompt.
 *
 * Media captions arrive as the message's own text (`messageCaption`), so the
 * description covers the attachment only. appending the caption here would
 * repeat it in the prompt.
 */
export function buildFilePromptText(processedFile: ProcessedFile): string {
  if (processedFile.imageData) {
    return `[Image attached: ${processedFile.fileName} (${processedFile.mimeType})]`;
  }

  if (processedFile.filePath) {
    return `[File attached: ${processedFile.fileName} (${processedFile.mimeType}) at ${processedFile.filePath}]`;
  }

  return "";
}

/** The file a `show_file` call sent the user, or null for another tool's call. */
export function sharedFileFromToolCall(
  toolName: string,
  args: unknown,
): { filePath: string; description?: string } | null {
  if (toolName !== SHOW_FILE_TOOL_NAME) return null;

  const { filePath, description } = (args ?? {}) as { filePath?: unknown; description?: unknown };
  if (typeof filePath !== "string" || !filePath) return null;

  return {
    filePath,
    ...(typeof description === "string" && description ? { description } : {}),
  };
}

/**
 * Send a file the agent showed with `show_file` to the user's Telegram chat.
 *
 * The web UI fetches the file on demand from the workspace; a phone has no such
 * client, so the bytes go with the answer instead. Failures are logged and
 * swallowed: the run is past the tool call that produced the file, and the
 * question of whether it could be uploaded must not fail the answer's text too.
 */
export async function sendSharedFileToTelegram(params: {
  userId: string;
  encryptedToken: string;
  telegramChatId: bigint;
  filePath: string;
  description?: string | undefined;
}): Promise<void> {
  const { userId, encryptedToken, telegramChatId, filePath, description } = params;

  try {
    const file = await readWorkspaceFile(userId, filePath);
    await sendTelegramFile(encryptedToken, telegramChatId, file, {
      caption: description?.trim() || file.fileName,
    });
  } catch (err) {
    console.error(
      `Failed to send workspace file "${filePath}" to Telegram chat ${telegramChatId}:`,
      err,
    );
  }
}
