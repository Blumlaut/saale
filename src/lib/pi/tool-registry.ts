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
};

// ─── Tool Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the full set of active tools from a ToolConfig.
 *
 * Backward compat: existing sessions may have { files: true } or { bash: true }.
 * These are mapped to { terminal: true } for resolution.
 */
export function resolveTools(
  userId: string,
  sessionId: string,
  config: Required<ToolConfig>,
  options: {
    createTerminalScopedTools: (
      userId: string,
      sessionId: string,
    ) => {
      read: ToolDefinition;
      write: ToolDefinition;
      edit: ToolDefinition;
      bash: ToolDefinition;
    };
  },
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // Backward compat: map legacy keys to terminal
  const terminalEnabled =
    config.terminal ||
    (config as Record<string, boolean>).files ||
    (config as Record<string, boolean>).bash;

  // ── Terminal tools (shell + file ops via open-terminal) ───────────────
  if (terminalEnabled && isTerminalConfigured()) {
    const terminal = options.createTerminalScopedTools(userId, sessionId);
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

  return tools;
}
