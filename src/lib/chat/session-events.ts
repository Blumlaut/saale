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

/** Tell every chat list that a title changed. */
export function broadcastChatRenamed(): void {
  window.dispatchEvent(new CustomEvent(CHAT_RENAMED_EVENT));
}

/**
 * Chats the server is removing. They stay in the lists, greyed, until the rows
 * are gone, so a list that hears this reads itself again.
 */
export const CHAT_SESSIONS_DELETING_EVENT = "chat-sessions-deleting";

/** Tell every chat list which chats are on their way out. */
export function broadcastSessionsDeleting(ids: readonly string[]): void {
  window.dispatchEvent(new CustomEvent(CHAT_SESSIONS_DELETING_EVENT, { detail: { ids } }));
}

/**
 * A chat was pinned or unpinned. `detail` carries which chat and its new state,
 * so the other lists move the row themselves instead of refetching.
 */
export const CHAT_PINNED_EVENT = "chat-pinned";

/** Tell every chat list that a chat's pin state changed. */
export function broadcastChatPinned(id: string, pinned: boolean): void {
  window.dispatchEvent(new CustomEvent(CHAT_PINNED_EVENT, { detail: { id, pinned } }));
}

/**
 * A watcher was added to a chat, moved off it, or deleted. The lists show a
 * mark on chats that owe their life to a watcher, so they re-read the sessions.
 * Which chat changed is not carried: the count comes back with the list.
 */
export const CHAT_WATCHERS_EVENT = "chat-watchers-changed";

/** Tell every chat list that the watchers bound to chats changed. */
export function broadcastWatchersChanged(): void {
  window.dispatchEvent(new CustomEvent(CHAT_WATCHERS_EVENT));
}
