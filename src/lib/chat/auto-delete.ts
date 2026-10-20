/**
 * Decide whether a chat session should be auto-deleted when the user leaves it.
 *
 * Two kinds of sessions don't need to persist:
 *  - temporary sessions. the privacy feature, nothing is meant to be
 *    permanently recorded in them, with or without messages
 *  - never-started sessions. a "new chat" click the user abandoned: no
 *    messages and no saved draft
 *
 * Drafts live in the browser's localStorage, invisible to the server, so the
 * decision has to be made on the client side where both facts are known.
 */

/** Never delete within the first second of a visit. fast navigation back and
 * forward would race a session that is still being set up. */
export const AUTO_DELETE_MIN_MOUNT_MS = 1000;

export function shouldAutoDeleteSession(input: {
  temporary: boolean;
  messageCount: number;
  hasDraft: boolean;
  busy: boolean;
  queuedCount: number;
  mountedForMs: number;
}): boolean {
  if (input.mountedForMs < AUTO_DELETE_MIN_MOUNT_MS) return false;
  // Never mid-activity: a generation running, or messages still waiting in
  // the send queue for this session.
  if (input.busy || input.queuedCount > 0) return false;
  if (input.temporary) return true;
  return input.messageCount === 0 && !input.hasDraft;
}
