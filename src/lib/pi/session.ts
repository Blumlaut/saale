import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createSandboxOperations } from "@/lib/sandbox/operations";
import { resolveSandboxEnv } from "@/lib/sandbox/env";
import { userIdentity } from "@/lib/sandbox/identity";
import { userWorkspacePath } from "@/lib/sandbox/workspace";
import { buildModelRuntime } from "./models";
import { sessionEnvVars } from "./session-env";
import { resolveTools } from "./tool-registry";
import { DEFAULT_TOOL_CONFIG, type ToolConfig, type ToolExposureConfig } from "./tool-categories";

// Re-export for consumers
export type { ToolConfig };

/**
 * Merge user tool config with defaults.
 */
function resolveToolConfig(config: ToolConfig | null | undefined): Required<ToolConfig> {
  if (!config) return DEFAULT_TOOL_CONFIG;
  return { ...DEFAULT_TOOL_CONFIG, ...config };
}

/**
 * Create workspace-backed Pi built-in tools.
 *
 * Commands run in the user's sandbox container, files are read and written
 * directly from the volume. The user's own environment variables are resolved
 * once, here: a pooled session is rebuilt when they change (the write path
 * evicts it), which is what keeps a value out of a long-lived object. Saale's
 * own `SAALE_*` variables are read per command instead, so a model switch mid
 * session shows up in the next command.
 */
export async function createSandboxScopedTools(
  userId: string,
  sessionId: string,
): Promise<{
  read: ToolDefinition;
  write: ToolDefinition;
  edit: ToolDefinition;
  bash: ToolDefinition;
}> {
  const homeDir = userWorkspacePath(userId);

  const userEnv = await resolveSandboxEnv(userId).catch((err) => {
    console.error("Failed to load sandbox environment variables:", err);
    return {};
  });

  const ops = createSandboxOperations({
    identity: userIdentity(userId),
    root: homeDir,
    // A name the user set wins over Saale's.
    env: () => ({ ...sessionEnvVars(userId, sessionId), ...userEnv }),
  });

  return {
    read: createReadTool(homeDir, { operations: ops.read }),
    write: createWriteTool(homeDir, { operations: ops.write }),
    edit: createEditTool(homeDir, { operations: ops.edit }),
    // `createBashTool` (the AgentTool form) rather than its ToolDefinition
    // variant: it drops Pi's TUI renderers, which a headless host never uses.
    bash: createBashTool(homeDir, { operations: ops.bash }),
  };
}

/**
 * Build the model runtime and resolve tools for a user.
 * Shared between createPiSession and createPersistentSession.
 */
export async function buildSessionDeps(options: {
  userId: string;
  sessionId: string;
  customTools: ToolDefinition[];
  toolConfig: ToolConfig | null | undefined;
  /** Per-category exposure (`AppSettings.toolExposure`). */
  toolExposure?: ToolExposureConfig | null | undefined;
  /** Per-tool approval policies (`AppSettings.toolPolicies`). */
  toolPolicies?: Record<string, string> | null | undefined;
  modelProvider: string | undefined;
  modelName: string | undefined;
}) {
  const { modelRuntime } = await buildModelRuntime(options.userId);

  const enabled = resolveToolConfig(options.toolConfig);

  const allCustomTools: ToolDefinition[] = [...options.customTools];

  const resolvedTools = await resolveTools(options.userId, options.sessionId, enabled, {
    createSandboxScopedTools,
    ...(options.toolExposure ? { exposure: options.toolExposure } : {}),
    toolPolicies: options.toolPolicies,
  });
  allCustomTools.push(...resolvedTools);

  let model;
  if (options.modelProvider && options.modelName) {
    model = modelRuntime.getModel(options.modelProvider, options.modelName);
  }

  return { modelRuntime, allCustomTools, model };
}
