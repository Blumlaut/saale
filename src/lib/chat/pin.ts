import { patchJson } from "@/lib/http";
import { broadcastChatPinned } from "@/lib/chat/session-events";

/**
 * Saves a chat's pin and tells the other chat lists.
 *
 * Every list pins through this one call: the chat view's sidebar, the phone
 * sheet and the coder panel all read the same column, and one of them moving a
 * row on its own would leave the others stale.
 */
export async function saveChatPin(sessionId: string, pinned: boolean): Promise<void> {
  await patchJson(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, { pinned });
  broadcastChatPinned(sessionId, pinned);
}
