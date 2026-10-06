import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolConfig, ToolCategoryKey, ToolExposureConfig } from "./tool-categories";
import { DEFAULT_TOOL_EXPOSURE, TOOL_CATEGORIES } from "./tool-categories";
import { findToolInfo } from "./tool-infos";
import { isConfigured as isTerminalConfigured } from "@/lib/terminal/client";
import { withAbortSignal } from "./tool-abort";
import { createChatTools, createShowFileTool } from "./tools/chat-tools";
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
 *
 * `sessionId` is the session the tools are being resolved for — most
 * categories ignore it, but a tool that acts on chats needs to know which
 * chat it belongs to (a chat must not respond to itself).
 */
type ToolFactory = (userId: string, sessionId: string) => ToolDefinition[] | ToolDefinition;

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
  chatSearch: (userId, sessionId) => createChatTools(userId, sessionId),
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

  // Collect from all factories (using dummy ids — we only need names/descriptions)
  const allTools: ToolInfo[] = [...terminalTools];

  for (const category of TOOL_CATEGORIES) {
    if (category.key === "terminal") continue;
    const factory = TOOL_FACTORIES[category.key];
    if (!factory) continue;

    const result = factory("dummy", "dummy") as ToolDefinition[];
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
 * @param options.exposure - Per-category exposure (`AppSettings.toolExposure`).
 *   Categories left at their default are resolved from `TOOL_CATEGORIES`;
 *   `codemode`/`deferred` tools are registered but not declared to the model,
 *   and codemode scripts reach them through the tool registry.
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
    /** How each category's tools reach the model. */
    exposure?: ToolExposureConfig | null | undefined;
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
        const result = factory(userId, sessionId);
        if (Array.isArray(result)) {
          tools.push(...result);
        } else {
          tools.push(result);
        }
      }
    }
  }

  // ── Put categories behind codemode ──────────────────────────────────
  // Exposure is how Pi decides whether a tool is declared to the model or only
  // reachable from a codemode script; the gate and abort wrappers below both
  // spread the definition, so it survives them. Categories the user left alone
  // keep their registry default.
  const exposed = applyToolExposure(tools, options.exposure ?? {});

  // ── Make every tool call cancellable ────────────────────────────────
  // Pi awaits tool execution and only checks the abort signal between tool
  // calls, so a Stop that arrives during a tool would otherwise not take effect
  // until that tool finishes. Applied before the approval wrapper, whose own
  // wait already honours the signal.
  const abortable = exposed.map(withAbortSignal);

  // ── Apply approval gate wrapper (if provided) ───────────────────────
  if (options.wrapWithApproval) {
    return abortable.map((t) => options.wrapWithApproval!(t));
  }

  return abortable;
}

/**
 * Set each tool's Pi exposure from its category: the user's setting when they
 * made one, otherwise the category's registry default.
 *
 * The category comes from the shared catalog (`tool-infos.ts`) rather than the
 * loop that produced the tool, because a category's tools are not always built
 * together: `show_file` ships with the terminal bundle but belongs to
 * "Chat history". Tools missing from the catalog stay `direct`.
 */
function applyToolExposure(
  tools: ToolDefinition[],
  exposure: ToolExposureConfig,
): ToolDefinition[] {
  return tools.map((tool) => {
    const category = findToolInfo(tool.name)?.category;
    if (!category) return tool;
    const level = exposure[category] ?? DEFAULT_TOOL_EXPOSURE[category];
    if (!level || level === "direct") return tool;
    return { ...tool, exposure: level };
  });
}
