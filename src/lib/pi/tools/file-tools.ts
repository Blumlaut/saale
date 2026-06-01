import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "fs/promises";
import path from "path";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/**
 * Sanitize a file path to prevent directory traversal.
 */
function sanitizePath(userId: string, filePath: string): string {
  const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
  return path.join(UPLOADS_DIR, userId, safePath);
}

/**
 * Create a file tool with userId injection.
 * Returns a factory function that creates the tool with the userId baked in.
 */
function createFileTool(userId: string) {
  return {
    fileRead: defineTool({
      name: "file_read",
      label: "Read File",
      description: "Read the contents of a file from the user's workspace.",
      parameters: Type.Object({
        path: Type.String({
          description: "File path relative to the user's workspace.",
        }),
      }),
      execute: async (_toolCallId: string, params: { path: string }) => {
        const fullPath = sanitizePath(userId, params.path);
        try {
          const content = await fs.readFile(fullPath, "utf8");
          return {
            content: [{ type: "text", text: `File: ${params.path}\n---\n${content}` }],
            details: { path: params.path, size: content.length },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error reading file "${params.path}": ${(err as Error).message}`,
              },
            ],
            details: { path: params.path, size: 0 },
          };
        }
      },
    }),

    fileWrite: defineTool({
      name: "file_write",
      label: "Write File",
      description:
        "Write content to a file in the user's workspace. Creates parent directories if needed.",
      parameters: Type.Object({
        path: Type.String({
          description: "File path relative to the user's workspace.",
        }),
        content: Type.String({
          description: "Content to write to the file.",
        }),
      }),
      execute: async (_toolCallId: string, params: { path: string; content: string }) => {
        const fullPath = sanitizePath(userId, params.path);
        try {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, params.content, "utf8");
          return {
            content: [
              {
                type: "text",
                text: `Successfully wrote ${params.content.length} bytes to ${params.path}`,
              },
            ],
            details: { path: params.path, bytes: params.content.length },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error writing file "${params.path}": ${(err as Error).message}`,
              },
            ],
            details: { path: params.path, bytes: 0 },
          };
        }
      },
    }),

    fileList: defineTool({
      name: "file_list",
      label: "List Files",
      description: "List files and directories in the user's workspace.",
      parameters: Type.Object({
        path: Type.Optional(
          Type.String({
            description: "Directory path relative to workspace. Default: root.",
          }),
        ),
        recursive: Type.Optional(
          Type.Boolean({
            description: "If true, list files recursively. Default: false.",
          }),
        ),
      }),
      execute: async (_toolCallId: string, params: { path?: string; recursive?: boolean }) => {
        const dirPath = sanitizePath(userId, params.path ?? ".");
        try {
          await fs.mkdir(dirPath, { recursive: true });

          async function listDir(dir: string, prefix = ""): Promise<string[]> {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            const results: string[] = [];

            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              const relPath = path.join(prefix, entry.name);

              if (entry.isDirectory()) {
                results.push(`📁 ${relPath}/`);
                if (params.recursive) {
                  results.push(...(await listDir(fullPath, relPath)));
                }
              } else {
                const stats = await fs.stat(fullPath);
                const size =
                  stats.size < 1024
                    ? `${stats.size}B`
                    : stats.size < 1024 * 1024
                      ? `${(stats.size / 1024).toFixed(1)}KB`
                      : `${(stats.size / (1024 * 1024)).toFixed(1)}MB`;
                results.push(`📄 ${relPath} (${size})`);
              }
            }

            return results;
          }

          const files = await listDir(dirPath);
          return {
            content: [
              {
                type: "text",
                text:
                  files.length > 0
                    ? files.join("\n")
                    : `Directory "${params.path ?? "."}" is empty`,
              },
            ],
            details: { count: files.length },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error listing directory "${params.path ?? "."}": ${(err as Error).message}`,
              },
            ],
            details: { count: 0 },
          };
        }
      },
    }),

    fileDelete: defineTool({
      name: "file_delete",
      label: "Delete File",
      description: "Delete a file from the user's workspace.",
      parameters: Type.Object({
        path: Type.String({
          description: "File path relative to the user's workspace.",
        }),
      }),
      execute: async (_toolCallId: string, params: { path: string }) => {
        const fullPath = sanitizePath(userId, params.path);
        try {
          await fs.unlink(fullPath);
          return {
            content: [{ type: "text", text: `Successfully deleted ${params.path}` }],
            details: { path: params.path },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Error deleting file "${params.path}": ${(err as Error).message}`,
              },
            ],
            details: { path: params.path },
          };
        }
      },
    }),
  };
}

// ─── Export factory for creating user-scoped file tools ─────────────────────

export { createFileTool };
