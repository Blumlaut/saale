/**
 * System-managed agent definitions.
 *
 * Saale auto-creates an AgentDefinition named {@link TELEGRAM_AGENT_NAME} to
 * bookkeep Telegram chat runs. That definition is owned by the system:
 * - Its `systemPrompt` is NOT what powers the chat (the chat rebuilds its own
 *   prompt from `AppSettings.agentCustomInstructions` per message), so editing
 *   it would be a silent no-op.
 * - It is created/updated automatically, so deleting or disabling it only
 *   causes it to be recreated with defaults.
 *
 * Consequently the name is reserved (no user-created job may use it) and the
 * definition is locked against edits, deletion, and manual runs. enforced in
 * both the REST API and the AI tools.
 */

/** Reserved name of the auto-created Telegram chat agent definition. */
export const TELEGRAM_AGENT_NAME = "Telegram Assistant";

/** Error message shown when a user tries to create or rename a job to the reserved name. */
export const RESERVED_AGENT_NAME_ERROR = `"${TELEGRAM_AGENT_NAME}" is managed by Saale and cannot be created or renamed to.`;

/** Error message shown when a user tries to edit, delete, or run a system-managed job. */
export const SYSTEM_MANAGED_ERROR = `"${TELEGRAM_AGENT_NAME}" is managed by Saale and cannot be edited, deleted, or run manually.`;

/** True when a job name collides with the reserved Telegram chat agent name. */
export function isReservedAgentName(name: string): boolean {
  return name.trim() === TELEGRAM_AGENT_NAME;
}
