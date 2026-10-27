import { deleteJson } from "@/lib/http";
import { broadcastSessionsDeleted } from "@/lib/chat/session-events";

/**
 * Deletes one chat and tells every list that showed it.
 *
 * The coder panel's chat list and the landing page's recent chats both delete a
 * row this way, and a delete that skipped the event would leave the other list
 * showing a chat that is gone.
 */
export async function deleteChat(sessionId: string, force: boolean): Promise<void> {
  await deleteJson(`/api/chat/sessions/${encodeURIComponent(sessionId)}${force ? "?force=1" : ""}`);
  broadcastSessionsDeleted([sessionId]);
}
