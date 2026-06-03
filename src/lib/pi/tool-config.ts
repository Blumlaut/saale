/**
 * Shared tool configuration types and defaults.
 * Single source of truth for both server (session.ts) and client (chat UI).
 */

/**
 * Configuration for which tool categories are enabled.
 */
export interface ToolConfig {
  bash?: boolean;
  files?: boolean;
  email?: boolean;
  jobs?: boolean;
  calendar?: boolean;
  chatSearch?: boolean;
  web?: boolean;
}

/**
 * Default tool configuration — all tools enabled except bash.
 */
export const DEFAULT_TOOL_CONFIG: Required<ToolConfig> = {
  bash: false, // Disabled by default — must be explicitly enabled
  files: true,
  email: true,
  jobs: true,
  calendar: true,
  chatSearch: true,
  web: true,
};
