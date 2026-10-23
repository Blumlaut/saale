/**
 * Window events that keep the chat lists in step with the server.
 *
 * More than one list of chats is mounted at once (the chat sidebar's desktop
 * panel and its mobile sheet, the coder panel, and now the coder panel's own
 * sheet), and they all read the same sessions. A rename or a delete happens in
 * whichever one the user reached for, so it is broadcast here instead of each
 * list polling the others.
 */

/** A chat's title changed. Dispatched once the new title is on the server. */
export const CHAT_RENAMED_EVENT = "chat-renamed";

/**
 * Chats are gone. `detail.ids` carries them, so a list can prune the rows
 * itself instead of paying a refetch.
 */
export const CHAT_SESSIONS_DELETED_EVENT = "chat-sessions-deleted";

/** Tell every chat list that a title changed. */
export function broadcastChatRenamed(): void {
  window.dispatchEvent(new CustomEvent(CHAT_RENAMED_EVENT));
}

/** Tell every chat list which chats were deleted. */
export function broadcastSessionsDeleted(ids: readonly string[]): void {
  window.dispatchEvent(new CustomEvent(CHAT_SESSIONS_DELETED_EVENT, { detail: { ids } }));
}
