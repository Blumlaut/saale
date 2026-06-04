import crypto from "crypto";
import { open } from "fs/promises";
import fs from "fs/promises";
import path from "path";
import {
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  SessionManager,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createTerminalOperations } from "@/lib/terminal/operations";
import { buildModelRegistry } from "./models";
import { resolveTools } from "./tool-registry";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "./tool-categories";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

// Re-export for consumers
export type { ToolConfig };

/**
 * Derive the open-terminal Linux username from a Saale user ID.
 * Mirrors open-terminal's sanitize_username() logic so we can compute
 * the user's home directory path for the SDK's cwd parameter.
 */
function deriveOpenTerminalUsername(userId: string): string {
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
function getTerminalHomeDir(userId: string): string {
  return `/home/${deriveOpenTerminalUsername(userId)}`;
}

/**
 * Merge user tool config with defaults.
 */
function resolveToolConfig(config: ToolConfig | null | undefined): Required<ToolConfig> {
  if (!config) return DEFAULT_TOOL_CONFIG;
  return { ...DEFAULT_TOOL_CONFIG, ...config };
}

/**
 * Get the isolated workspace directory for a user.
 */
function getUserDir(userId: string): string {
  return path.join(UPLOADS_DIR, userId);
}

/**
 * Validate that a resolved path stays within the allowed base directory.
 * Throws if the path escapes the sandbox.
 * Uses realpath-style resolution to catch symlink escapes.
 */
function validatePath(baseDir: string, filePath: string): void {
  const resolved = path.resolve(baseDir, filePath);
  // Normalize the base dir for consistent comparison
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Access denied: path "${filePath}" escapes user workspace`);
  }
}

/**
 * Detect image MIME type by reading magic bytes from a file.
 * Returns the MIME type string for supported images, or null for non-images.
 * Matches Pi's internal `detectSupportedImageMimeTypeFromFile` behavior.
 */
async function detectImageMimeType(filePath: string): Promise<string | null> {
  const fileHandle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(4100);
    const { bytesRead } = await fileHandle.read(buffer, 0, 4100, 0);
    const data = buffer.subarray(0, bytesRead);

    // JPEG: FF D8 FF (skip FF D8 FF F7 which is a special variant)
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
      return data[3] === 0xf7 ? null : "image/jpeg";
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A + valid IHDR chunk
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (data.length >= 16 && PNG_SIG.every((b, i) => data[i] === b)) {
      // Check for IHDR at offset 8 (chunk length=13, type="IHDR")
      const chunkLen =
        ((data[8] ?? 0) << 24) | ((data[9] ?? 0) << 16) | ((data[10] ?? 0) << 8) | (data[11] ?? 0);
      if (
        chunkLen === 13 &&
        data[12] === 0x49 &&
        data[13] === 0x48 &&
        data[14] === 0x44 &&
        data[15] === 0x52
      ) {
        return "image/png";
      }
      return null; // Has PNG sig but not a valid PNG
    }

    // GIF: starts with ASCII "GIF"
    if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      return "image/gif";
    }

    // WebP: starts with "RIFF" then "WEBP" at offset 8
    if (
      data.length >= 12 &&
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46 &&
      data[8] === 0x57 &&
      data[9] === 0x45 &&
      data[10] === 0x42 &&
      data[11] === 0x50
    ) {
      return "image/webp";
    }

    return null;
  } finally {
    await fileHandle.close();
  }
}

/**
 * Create local (host-side) Pi built-in tools locked to the user's workspace.
 * Used when bash is disabled — fast, no network overhead.
 */
function createLocalScopedTools(userId: string) {
  const userDir = getUserDir(userId);

  return {
    // Scoped read tool — locked to user directory
    read: createReadTool(userDir, {
      operations: {
        readFile: async (absolutePath: string) => {
          validatePath(userDir, absolutePath);
          return await fs.readFile(absolutePath);
        },
        access: async (absolutePath: string) => {
          validatePath(userDir, absolutePath);
          await fs.access(absolutePath);
        },
        detectImageMimeType: async (absolutePath: string) => {
          validatePath(userDir, absolutePath);
          return await detectImageMimeType(absolutePath);
        },
      },
    }),

    // Scoped write tool — locked to user directory
    write: createWriteTool(userDir, {
      operations: {
        writeFile: async (absolutePath: string, content: string) => {
          validatePath(userDir, absolutePath);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, content, "utf8");
        },
        mkdir: async (dir: string) => {
          validatePath(userDir, dir);
          await fs.mkdir(dir, { recursive: true });
        },
      },
    }),

    // Scoped edit tool — locked to user directory
    edit: createEditTool(userDir, {
      operations: {
        readFile: async (absolutePath: string) => {
          validatePath(userDir, absolutePath);
          return await fs.readFile(absolutePath);
        },
        writeFile: async (absolutePath: string, content: string) => {
          validatePath(userDir, absolutePath);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, content, "utf8");
        },
        access: async (absolutePath: string) => {
          validatePath(userDir, absolutePath);
          await fs.access(absolutePath);
        },
      },
    }),
  };
}

/**
 * Create terminal-backed Pi built-in tools (sandboxed via open-terminal).
 * Used when bash is enabled — all file ops go through the container.
 */
function createTerminalScopedTools(userId: string, sessionId: string) {
  const homeDir = getTerminalHomeDir(userId);
  const ops = createTerminalOperations({ userId, sessionId, cwd: homeDir });

  return {
    read: createReadTool(homeDir, { operations: ops.read }),
    write: createWriteTool(homeDir, { operations: ops.write }),
    edit: createEditTool(homeDir, { operations: ops.edit }),
    bash: createBashTool(homeDir, { operations: ops.bash }),
  };
}

/**
 * Create an isolated Pi agent session for a user.
 */
export async function createPiSession(options: {
  userId: string;
  customTools: ToolDefinition[];
  toolConfig?: ToolConfig;
  modelProvider?: string;
  modelName?: string;
  thinkingLevel?: string;
}): Promise<CreateAgentSessionResult> {
  // Ensure the user's workspace directory exists
  const userDir = getUserDir(options.userId);
  await fs.mkdir(userDir, { recursive: true });

  // Build model registry with user's providers and discovered models
  const { modelRegistry, authStorage } = await buildModelRegistry(options.userId);

  // Resolve tool config (which tool categories are enabled)
  const enabled = resolveToolConfig(options.toolConfig);

  // Generate a session ID for open-terminal cwd persistence
  const sessionId = crypto.randomUUID();

  // Build user-scoped custom tools (only if enabled)
  const allCustomTools: ToolDefinition[] = [...options.customTools];

  // Resolve tools from the registry (handles bash/files interdependency + all custom tools)
  const resolvedTools = resolveTools(options.userId, sessionId, enabled, {
    createLocalScopedTools,
    createTerminalScopedTools,
  });
  allCustomTools.push(...resolvedTools);

  // Resolve the model if specified
  let model;
  if (options.modelProvider && options.modelName) {
    model = modelRegistry.find(options.modelProvider, options.modelName);
  }

  const result = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    noTools: "builtin",
    ...(model ? { model } : {}),
    customTools: allCustomTools,
    thinkingLevel:
      (options.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh") ?? "off",
  });

  return result;
}
