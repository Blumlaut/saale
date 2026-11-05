import path from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { getUploadsDir } from "@/lib/uploads";
import { isSessionBusy } from "@/lib/redis";
import { getLinkByUserId } from "./links";
import { withChatLock } from "./chat-lock";

/** Custom-entry type used when replaying outbound job messages into the Pi transcript. */
const JOB_OUTPUT_CUSTOM_TYPE = "job_output";

/**
 * The chat a delivery came from, when it exists and belongs to the user.
 *
 * A scope id is not proof of a chat: a watcher script with no conversation of
 * its own reaches chat-aware tools as `watcher:<id>`. Writing that id as the
 * source would point the link at a chat that does not exist, which then refuses
 * every message the user sends.
 */
export async function resolveSourceChat(
  userId: string,
  sourceSessionId: string | null | undefined,
): Promise<string | null> {
  if (!sourceSessionId) return null;

  const chat = await prisma.chatSession.findFirst({
    where: { id: sourceSessionId, userId },
    select: { id: true },
  });
  if (chat) return sourceSessionId;

  console.warn(
    `[telegram] Outbound message for user ${userId} named an unknown chat ${sourceSessionId}`,
  );
  return null;
}

/**
 * Persist an outbound message into the chat that produced it, so a reply has
 * context.
 *
 * The chat's agent lives in its own Pi transcript, and the web UI reads the
 * `ChatMessage` rows, so both are written:
 *
 *  - a `ChatMessage` row (assistant) so the web UI shows the message in the
 *    thread that sent it, and the session does not expire between the message
 *    and the reply (session expiry is driven by the latest message timestamp),
 *  - a custom entry in that chat's Pi transcript, which the agent reads as
 *    conversation context (custom entries convert to a user message for the
 *    model).
 *
 * `sourceSessionId` is the chat that sent the message. A delivery no chat
 * produced (a watcher, a reminder) is not recorded: it never came from a thread.
 *
 * `sentTo` is a group title. A group message is recorded as a one-line
 * breadcrumb instead of its full text: the chat that produced it needs to know
 * where it went, and the whole message would read as something the agent said
 * to the user privately.
 *
 * The transcript entry is skipped while the chat is generating: Pi's session
 * manager owns that file for the duration of a run. The DB row still lands, so
 * the thread is never missing the message.
 */
export async function recordOutboundMessage(params: {
  userId: string;
  content: string;
  sourceSessionId?: string | null | undefined;
  /** Group title, when the message went to a group rather than the private chat. */
  sentTo?: string | null | undefined;
}): Promise<void> {
  const { userId, content, sourceSessionId, sentTo } = params;
  if (!content.trim()) return;

  const link = await getLinkByUserId(userId);
  const sessionId = await resolveSourceChat(userId, sourceSessionId);
  if (!sessionId) return;

  const recorded = sentTo ? buildGroupBreadcrumb(content, sentTo) : content;

  await prisma.chatMessage.create({
    data: { sessionId, role: "assistant", content: recorded },
  });

  // New chat content. advance lastActivityAt so the session list sorts it
  // correctly and the chat's expiry window restarts.
  await prisma.chatSession
    .update({ where: { id: sessionId }, data: { lastActivityAt: new Date() } })
    .catch((err) => {
      console.error(`Failed to bump lastActivityAt for telegram session ${sessionId}:`, err);
    });

  if (await isSessionBusy(userId, sessionId)) {
    console.warn(`[telegram] Chat ${sessionId} is busy. transcript entry skipped`);
    return;
  }

  // Append under the chat lock so it cannot interleave with an active run
  // writing to the same transcript file.
  await withChatLock(`${userId}:${link?.telegramChatId ?? sessionId}`, async () => {
    const sessionDir = path.join(getUploadsDir(), "pi_sessions", userId, sessionId);
    const manager = SessionManager.continueRecent(sessionDir, sessionDir);
    manager.appendCustomMessageEntry(
      JOB_OUTPUT_CUSTOM_TYPE,
      `[Telegram message sent to the user]\n${recorded}`,
      false,
      { channel: "telegram" },
    );
  });
}

/** `[sent to "CVEs"] The first line…` — enough context without the whole message. */
function buildGroupBreadcrumb(content: string, groupTitle: string): string {
  const firstLine = content.trim().split("\n")[0]?.trim() ?? "";
  return `[sent to "${groupTitle}"] ${firstLine}`;
}
