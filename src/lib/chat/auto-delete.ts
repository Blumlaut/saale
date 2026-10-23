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

/** Why a chat that asked to be auto-deleted was kept instead. */
export type AutoDeleteKeepReason = "missing" | "provisioning" | "running" | "started";

/**
 * The server's half of the same decision: what the client claims, checked
 * against what is actually happening.
 *
 * The client decides from its own state, and that state can lag the server. A
 * coder chat whose first message is being answered looks idle on screen while
 * its workspace is built for minutes (the run is not registered as active yet,
 * see `prepareRun`), so "no messages, not busy" is exactly what a chat that is
 * being set up looks like from the browser. Deleting on that guess throws away
 * a chat the user started; the guard here is what makes it impossible.
 *
 * Returns the reason to keep the chat, or null when it really is abandoned.
 */
export function keepAutoDeletedSession(input: {
  temporary: boolean;
  messageCount: number;
  running: boolean;
  provisioning: boolean;
}): AutoDeleteKeepReason | null {
  // A workspace is being built: work in flight, and the chat is not abandoned.
  if (input.provisioning) return "provisioning";
  // A generation is running somewhere.
  if (input.running) return "running";
  // A visible conversation is never auto-deleted; only a temporary chat goes
  // with the tab once it has one.
  if (!input.temporary && input.messageCount > 0) return "started";
  return null;
}

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
