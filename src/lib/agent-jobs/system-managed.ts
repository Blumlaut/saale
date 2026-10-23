/**
 * System-managed agent definitions.
 *
 * Some definitions exist to bookkeep something Saale runs itself (the watcher
 * wake agent), and their prompt and tools are rebuilt by the code that owns
 * them. Editing one would be a silent no-op, and deleting it only causes it to
 * be recreated with defaults, so they are locked against edits, deletion and
 * manual runs. enforced in both the REST API and the AI tools.
 */

/** Error message shown when a user tries to edit, delete, or run a system-managed job. */
export const SYSTEM_MANAGED_ERROR =
  "This agent is managed by Saale and cannot be edited, deleted, or run manually.";
