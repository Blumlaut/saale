import fs from "fs/promises";
import type { Stats } from "fs";
import path from "path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import * as terminal from "@/lib/terminal/client";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/** Max file size for show_file (5 MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** MIME types by file extension */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
};

/** Guess MIME type from file extension */
function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/** Check if a MIME type is an image */
function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Get the isolated workspace directory for a user.
 */
function getUserDir(userId: string): string {
  return path.join(UPLOADS_DIR, userId);
}

/**
 * Validate that a resolved path stays within the allowed base directory.
 */
function validatePath(baseDir: string, filePath: string): void {
  const resolved = path.resolve(baseDir, filePath);
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Access denied: path "${filePath}" escapes user workspace`);
  }
}

/**
 * Create a chat search tool with userId injection.
 * Returns a factory function that creates the tool with the userId baked in.
 */
export function createChatSearchTool(userId: string) {
  return defineTool({
    name: "chat_search",
    label: "Search Chat History",
    description: "Search through chat history by query. Returns matching sessions and messages.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query to match against chat messages.",
      }),
      limit: Type.Optional(
        Type.Integer({
          description: "Maximum number of results. Default: 20.",
          default: 20,
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: { query: string; limit?: number }) => {
      const searchQuery = params.query.trim();
      const limit = Math.min(params.limit ?? 20, 100);

      // Use PostgreSQL full-text search for efficient, ranked results.
      // Joins ChatSession + ChatMessage, searches both title and content.
      const results = await prisma.$queryRaw<
        Array<{
          sessionId: string;
          sessionTitle: string;
          messageId: string;
          role: string;
          content: string;
          date: string;
          rank: number;
        }>
      >(
        Prisma.sql`
          SELECT
            "ChatSession".id AS "sessionId",
            "ChatSession".title AS "sessionTitle",
            "ChatMessage".id AS "messageId",
            "ChatMessage".role,
            LEFT("ChatMessage".content, 300) AS content,
            "ChatMessage"."createdAt"::text AS date,
            ts_rank(
              to_tsvector('english', COALESCE("ChatMessage".content, '')),
              plainto_tsquery('english', ${searchQuery})
            ) AS rank
          FROM "ChatMessage"
          JOIN "ChatSession" ON "ChatMessage"."sessionId" = "ChatSession".id
          WHERE "ChatSession"."userId" = ${userId}
            AND to_tsvector('english', COALESCE("ChatMessage".content, '')) @@ plainto_tsquery('english', ${searchQuery})
          ORDER BY rank DESC
          LIMIT ${limit}
        `,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query: params.query,
                count: results.length,
                results: results.map((r) => ({
                  sessionId: r.sessionId,
                  sessionTitle: r.sessionTitle,
                  messageId: r.messageId,
                  role: r.role,
                  content: r.content,
                  date: r.date,
                })),
              },
              null,
              2,
            ),
          },
        ],
        details: { count: results.length },
      };
    },
  });
}

/**
 * Create a show_file tool that reads a file from the user's workspace
 * and returns it as a data URI for the user to view/download in chat.
 *
 * Only enabled when bash tools are active (implies workspace access).
 * When terminal is configured, reads through the Open Terminal API.
 */
export function createShowFileTool(userId: string, sessionId: string) {
  const useTerminal = terminal.isConfigured();

  return defineTool({
    name: "show_file",
    label: "Show File",
    description:
      "Send a file to the user in the chat. The file will be displayed inline (images) or as a download link. " +
      "Path is relative to the workspace root. Max file size: 5MB.",
    parameters: Type.Object({
      filePath: Type.String({
        description: "Path to the file, relative to the workspace root.",
      }),
      description: Type.Optional(
        Type.String({
          description: "Optional description of what this file is.",
        }),
      ),
    }),
    execute: async (_toolCallId: string, params: { filePath: string; description?: string }) => {
      const { filePath, description } = params;
      const fileName = path.basename(filePath);

      if (useTerminal) {
        const homeDir = terminal.getTerminalHomeDir(userId);
        const fullPath = path.resolve(homeDir, filePath);

        // Validate path stays within user home
        const normalizedBase = path.resolve(homeDir);
        if (!fullPath.startsWith(normalizedBase + path.sep) && fullPath !== normalizedBase) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Access denied: path "${filePath}" escapes workspace`,
              },
            ],
            details: { fileName, size: 0, mimeType: "" },
            isError: true,
          };
        }

        try {
          const result = await terminal.readFileBinary(fullPath, { userId, sessionId });

          if (result.buffer.length > MAX_FILE_SIZE) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `File too large: ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB. Max: ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB.`,
                },
              ],
              details: { fileName, size: result.buffer.length, mimeType: "" },
              isError: true,
            };
          }

          const mimeType = !result.mimeType.startsWith("application/octet-stream")
            ? result.mimeType
            : guessMimeType(filePath);
          const sizeLabel =
            result.buffer.length > 1024 * 1024
              ? `${(result.buffer.length / 1024 / 1024).toFixed(1)} MB`
              : result.buffer.length > 1024
                ? `${(result.buffer.length / 1024).toFixed(0)} KB`
                : `${result.buffer.length} B`;

          const typeLabel = isImageMime(mimeType) ? "image" : "file";
          const prefix = description ? `${description}. ` : "";

          return {
            content: [
              {
                type: "text" as const,
                text: `${prefix}Shared ${typeLabel} "${fileName}" (${sizeLabel}).`,
              },
            ],
            details: { fileName, size: result.buffer.length, mimeType },
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404")) {
            return {
              content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
              details: { fileName, size: 0, mimeType: "" },
              isError: true,
            };
          }
          throw err;
        }
      } else {
        const userDir = getUserDir(userId);

        // Validate path stays within workspace
        validatePath(userDir, filePath);

        const fullPath = path.resolve(userDir, filePath);

        // Check file exists and get stats
        let stats: Stats;
        try {
          stats = await fs.stat(fullPath);
        } catch {
          return {
            content: [{ type: "text" as const, text: `File not found: ${filePath}` }],
            details: { fileName, size: 0, mimeType: "" },
            isError: true,
          };
        }

        if (!stats.isFile()) {
          return {
            content: [{ type: "text" as const, text: `Not a file: ${filePath}` }],
            details: { fileName, size: 0, mimeType: "" },
            isError: true,
          };
        }

        if (stats.size > MAX_FILE_SIZE) {
          return {
            content: [
              {
                type: "text" as const,
                text: `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB. Max: ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB.`,
              },
            ],
            details: { fileName, size: stats.size, mimeType: "" },
            isError: true,
          };
        }

        const mimeType = guessMimeType(filePath);
        const sizeLabel =
          stats.size > 1024 * 1024
            ? `${(stats.size / 1024 / 1024).toFixed(1)} MB`
            : stats.size > 1024
              ? `${(stats.size / 1024).toFixed(0)} KB`
              : `${stats.size} B`;

        const typeLabel = isImageMime(mimeType) ? "image" : "file";
        const prefix = description ? `${description}. ` : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `${prefix}Shared ${typeLabel} "${fileName}" (${sizeLabel}).`,
            },
          ],
          details: { fileName, size: stats.size, mimeType },
        };
      }
    },
  });
}
