import { postJson } from "@/lib/http";
import { broadcastSessionsDeleting } from "@/lib/chat/session-events";
import { forcedRetryError, isForcedRetry } from "@/lib/coder/force-delete";

/** Answer of the delete endpoint. ids on their way out, ids it could not start. */
export interface DeleteChatsResponse {
  queued: string[];
  failed: Array<{ sessionId: string; error: string; code?: string }>;
}

/**
 * Ask the server to delete these chats and tell every list that showed them.
 *
 * The removal runs on the server, so the rows stay in the lists, greyed, until
 * they are gone. The chat sidebar and the coder panel both delete through here,
 * and a delete that skipped the event would leave another list showing a chat
 * that is on its way out.
 */
export async function requestChatDelete(
  ids: readonly string[],
  force: boolean,
): Promise<DeleteChatsResponse> {
  const result = await postJson<DeleteChatsResponse>(
    "/api/chat/sessions/delete",
    force ? { ids, force: true } : { ids },
  );
  broadcastSessionsDeleting(result.queued);
  return result;
}

/**
 * The error a delete's failures report.
 *
 * A checkout that refused carries a code, and a box that can ask again turns
 * that into the second question. Anything else is a plain failure.
 */
export function deleteFailure(failed: DeleteChatsResponse["failed"]): Error {
  const reason = failed[0]?.error ?? "Could not delete the chat";
  return failed.every((failure) => isForcedRetry(failure.code))
    ? forcedRetryError(reason)
    : new Error(reason);
}
