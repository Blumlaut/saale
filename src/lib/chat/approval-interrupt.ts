import { readImageAsBase64 } from "@/lib/image-attachment";
import { get, getPoolKey } from "@/lib/pi/agent-pool";
import type { ImageContent } from "@/lib/pi/message-replay";
import { getPendingApprovals, resolveApproval } from "@/lib/pi/tool-approval-gate";

export type ApprovalInterruptMode = "steered" | "queued";

/**
 * A message that arrives while tool approvals are pending is the user's
 * answer to them: the pending requests are denied, and the message is handed
 * to the running agent right away. via `session.steer()`, which delivers it
 * as soon as the (denied) tool calls finish, before the next LLM call. The
 * model sees the denials *and* what the user actually wants.
 *
 * Called only while the session is busy, and only meaningful when approvals
 * are actually pending.
 *
 * @returns
 * - `null`. nothing was pending; the caller uses its normal busy/idle path
 * - `"steered"`. approvals denied and the message injected into the running
 *   turn (the message belongs in the conversation, not the send queue)
 * - `"queued"`. approvals denied but the message could not be injected in
 *   this process (agent lives in another instance, or the session is not
 *   streaming); the caller keeps it in the send queue, and the drain delivers
 *   it as soon as the unwinding run settles
 */
export async function interruptPendingApprovals(options: {
  userId: string;
  sessionId: string;
  content: string;
  attachments?: { storagePath: string; mimeType: string }[];
}): Promise<ApprovalInterruptMode | null> {
  const { userId, sessionId, content } = options;

  const pending = await getPendingApprovals(sessionId);
  if (pending.length === 0) return null;

  // Deny every pending request before injecting, so the run unwinds from all
  // of its approval waits (a turn can block on several at once).
  for (const request of pending) {
    await resolveApproval(sessionId, request.toolCallId, false);
  }

  const pooled = get(getPoolKey(userId, sessionId));
  if (!pooled || !pooled.session.isStreaming) {
    return "queued";
  }

  const images = await loadImageContent(userId, options.attachments ?? []);

  try {
    await (images.length > 0
      ? pooled.session.steer(content, images)
      : pooled.session.steer(content));
  } catch (err) {
    // Denials already happened. fall back to the queue so the message is
    // not lost; the drain delivers it when the run settles.
    console.error(
      `Failed to steer message into session ${sessionId} after denying approvals:`,
      err,
    );
    return "queued";
  }

  return "steered";
}

/** Vision content for image attachments; non-image files are already
 *  referenced by path in the content. A failing read is logged and skipped,
 *  never the whole steer. */
async function loadImageContent(
  userId: string,
  attachments: { storagePath: string; mimeType: string }[],
): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const att of attachments) {
    if (!att.mimeType.startsWith("image/")) continue;
    try {
      const { data, mimeType } = await readImageAsBase64(userId, att.storagePath);
      images.push({ type: "image" as const, data, mimeType });
    } catch (err) {
      console.error(`Failed to load image for steered message:`, err);
    }
  }
  return images;
}
