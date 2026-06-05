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
  bash: (_userId) => {
    // Bash tool is created alongside file tools (see files factory below)
    // This placeholder is handled specially in resolveTools()
    return [];
  },
  files: (_userId) => {
    // File tools are created alongside bash (see bash handling in resolveTools)
    return [];
  },
  email: (userId) => createMailTools(userId),
  jobs: (userId) => createJobTools(userId),
  calendar: (userId) => createCalendarTools(userId),
  chatSearch: (userId) => createChatSearchTool(userId),
  web: () => createWebTools(),
  memory: (userId) => createMemoryTools(userId),
};

// ─── Tool Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the full set of active tools from a ToolConfig.
 * Handles the bash/files interdependency (they share the same backend).
 */
export function resolveTools(
  userId: string,
  sessionId: string,
  config: Required<ToolConfig>,
  options: {
    createLocalScopedTools: (userId: string) => {
      read: ToolDefinition;
      write: ToolDefinition;
      edit: ToolDefinition;
    };
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

  // ── Pi built-in tools (bash + files share a backend) ──────────────────
  if (config.bash && isTerminalConfigured()) {
    const terminal = options.createTerminalScopedTools(userId, sessionId);
    if (config.files) {
      tools.push(terminal.read, terminal.write, terminal.edit);
    }
    tools.push(terminal.bash);
    tools.push(createShowFileTool(userId, sessionId));
  } else if (config.bash) {
    console.warn("Bash tools enabled but OPEN_TERMINAL_API_KEY is not set. Bash tools disabled.");
    if (config.files) {
      const local = options.createLocalScopedTools(userId);
      tools.push(local.read, local.write, local.edit);
    }
  } else if (config.files) {
    const local = options.createLocalScopedTools(userId);
    tools.push(local.read, local.write, local.edit);
  }

  // ── Custom tools (dispatched via registry) ────────────────────────────
  for (const category of TOOL_CATEGORIES) {
    // Skip bash/files — handled above
    if (category.key === "bash" || category.key === "files") continue;

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
