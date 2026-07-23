import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolConfig, ToolCategoryKey } from "./tool-categories";
import { TOOL_CATEGORIES } from "./tool-categories";
import { isConfigured as isTerminalConfigured } from "@/lib/terminal/client";
import { createChatSearchTool, createShowFileTool } from "./tools/chat-tools";
import { createMailTools } from "./tools/mail-tools";
import { createJobTools } from "./tools/job-tools";
import { createCalendarTools } from "./tools/calendar-tools";
import { createWebTools } from "./tools/web-tools";
import { createMemoryTools } from "./tools/memory-tools";
import { createTaskTools } from "./tools/task-tools";
import { createAgentJobTools } from "./tools/agent-job-tools";
import { createInfraTools } from "./tools/infra-tools";

// ─── Tool Factory Registry ───────────────────────────────────────────────────

/**
 * Factory function that creates tools for a given category.
 * Some categories need userId for user isolation; others do not.
 */
type ToolFactory = (userId: string) => ToolDefinition[] | ToolDefinition;

/**
 * Registry mapping tool category keys to their factory functions.
 * For categories with built-in Pi tools (bash, files), the factory is inline.
 * For custom categories, it delegates to the dedicated tool module.
 */
const TOOL_FACTORIES: Record<ToolCategoryKey, ToolFactory> = {
  terminal: (_userId) => {
    // Terminal tools are created inline in resolveTools()
    return [];
  },
  email: (userId) => createMailTools(userId),
  jobs: (userId) => createJobTools(userId),
  calendar: (userId) => createCalendarTools(userId),
  chatSearch: (userId) => createChatSearchTool(userId),
  web: () => createWebTools(),
  memory: (userId) => createMemoryTools(userId),
  tasks: (userId) => createTaskTools(userId),
  agentJobs: (userId) => createAgentJobTools(userId),
  infra: (userId) => createInfraTools(userId),
};

// ─── Tool Resolution ─────────────────────────────────────────────────────────

/**
 * Metadata for a single tool (name + description + label).
 * Used by the settings UI to render per-tool policy selectors.
 */
export interface ToolInfo {
  name: string;
  label: string;
  description: string;
}

/**
 * Get all available tool names and descriptions.
 * Used by the settings UI to render per-tool policy selectors.
 * Does not require a userId — returns the static catalog of all tools.
 */
export function getAllToolInfos(): ToolInfo[] {
  // Terminal tools (built-in Pi tools)
  const terminalTools: ToolInfo[] = [
    { name: "read", label: "Read", description: "Read file contents" },
    { name: "write", label: "Write", description: "Write content to a file" },
    { name: "edit", label: "Edit", description: "Edit a file with targeted replacements" },
    { name: "bash", label: "Bash", description: "Execute shell commands" },
  ];

  // Collect from all factories (using a dummy userId — we only need names/descriptions)
  const allTools: ToolInfo[] = [...terminalTools];

  for (const category of TOOL_CATEGORIES) {
    if (category.key === "terminal") continue;
    const factory = TOOL_FACTORIES[category.key];
    if (!factory) continue;

    const result = factory("dummy") as ToolDefinition[];
    const tools = Array.isArray(result) ? result : [result];
    for (const t of tools) {
      allTools.push({
        name: t.name,
        label: t.label,
        description: t.description,
      });
    }
  }

  return allTools;
}

/**
 * Resolve the full set of active tools from a ToolConfig.
 *
 * Backward compat: existing sessions may have { files: true } or { bash: true }.
 * These are mapped to { terminal: true } for resolution.
 *
 * @param options.wrapWithApproval - Optional wrapper to apply to each resolved tool.
 *   Receives the tool, userId, sessionId, policy lookup, and approval emitter.
 */
export async function resolveTools(
  userId: string,
  sessionId: string,
  config: Required<ToolConfig>,
  options: {
    createTerminalScopedTools: (
      userId: string,
      sessionId: string,
    ) => Promise<{
      read: ToolDefinition;
      write: ToolDefinition;
      edit: ToolDefinition;
      bash: ToolDefinition;
    }>;
    /** Optional approval gate wrapper. When provided, every tool is wrapped. */
    wrapWithApproval?: (tool: ToolDefinition) => ToolDefinition;
  },
): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];

  // Backward compat: map legacy keys to terminal
  const terminalEnabled =
    config.terminal ||
    (config as Record<string, boolean>).files ||
    (config as Record<string, boolean>).bash;

  // ── Terminal tools (shell + file ops via open-terminal) ───────────────
  if (terminalEnabled && isTerminalConfigured()) {
    const terminal = await options.createTerminalScopedTools(userId, sessionId);
    tools.push(terminal.read, terminal.write, terminal.edit, terminal.bash);
    tools.push(createShowFileTool(userId, sessionId));
  } else if (terminalEnabled) {
    console.warn(
      "Terminal enabled but OPEN_TERMINAL_API_KEY is not set. Terminal tools unavailable.",
    );
  }

  // ── Custom tools (dispatched via registry) ────────────────────────────
  for (const category of TOOL_CATEGORIES) {
    // Skip terminal — handled above
    if (category.key === "terminal") continue;

    if (config[category.key]) {
      const factory = TOOL_FACTORIES[category.key];
      if (factory) {
        const result = factory(userId);
        if (Array.isArray(result)) {
          tools.push(...result);
        } else {
          tools.push(result);
        }
      }
    }
  }

  // ── Apply approval gate wrapper (if provided) ───────────────────────
  if (options.wrapWithApproval) {
    return tools.map((t) => options.wrapWithApproval!(t));
  }

  return tools;
}
