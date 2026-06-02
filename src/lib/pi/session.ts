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
import { buildModelRegistry } from "./models";
import { createChatSearchTool } from "./tools/chat-tools";
import { createMailTools } from "./tools/mail-tools";
import { createJobTools } from "./tools/job-tools";
import { createWebTools } from "./tools/web-tools";

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR ?? "./uploads");

/**
 * Configuration for which tool categories are enabled.
 */
export interface ToolConfig {
  bash?: boolean;
  files?: boolean;
  email?: boolean;
  jobs?: boolean;
  chatSearch?: boolean;
  web?: boolean;
}

const DEFAULT_TOOL_CONFIG: Required<ToolConfig> = {
  bash: false, // Disabled by default — must be explicitly enabled
  files: true,
  email: true,
  jobs: true,
  chatSearch: true,
  web: true,
};

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
 * Create scoped Pi built-in tools locked to the user's workspace.
 */
function createScopedTools(userId: string) {
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

    // Scoped bash tool — cwd forced to user directory on every invocation
    bash: createBashTool(userDir, {
      spawnHook: (ctx) => ({
        ...ctx,
        cwd: userDir,
      }),
    }),
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

  // Build user-scoped custom tools (only if enabled)
  const allCustomTools: ToolDefinition[] = [...options.customTools];

  // Pi built-in tools — scoped to user workspace
  const scoped = createScopedTools(options.userId);

  if (enabled.files) {
    allCustomTools.push(scoped.read, scoped.write, scoped.edit);
  }

  if (enabled.bash) {
    allCustomTools.push(scoped.bash);
  }

  if (enabled.chatSearch) {
    allCustomTools.push(createChatSearchTool(options.userId));
  }

  if (enabled.email) {
    const mailTools = createMailTools(options.userId);
    allCustomTools.push(
      mailTools.mailAccountsTool,
      mailTools.mailFoldersTool,
      mailTools.mailSyncTool,
      mailTools.mailListTool,
      mailTools.mailReadTool,
      mailTools.mailSearchTool,
      mailTools.mailSendTool,
      mailTools.mailTagTool,
      mailTools.mailMoveTool,
      mailTools.mailDeleteTool,
    );
  }

  if (enabled.jobs) {
    const jobTools = createJobTools(options.userId);
    allCustomTools.push(
      jobTools.jobListTool,
      jobTools.jobEnableTool,
      jobTools.jobRunTool,
      jobTools.jobLogsTool,
    );
  }

  if (enabled.web) {
    const webTools = createWebTools();
    allCustomTools.push(webTools.webSearchTool, webTools.webFetchTool);
  }

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
