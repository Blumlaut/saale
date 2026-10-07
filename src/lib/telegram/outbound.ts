import path from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { getUploadsDir } from "@/lib/uploads";
import { withChatLock } from "./chat-lock";

/** Custom-entry type used when replaying outbound job messages into the Pi transcript. */
const JOB_OUTPUT_CUSTOM_TYPE = "job_output";

/**
 * Persist an outbound job message into the Telegram chat's chat session so a
 * follow-up reply has context.
 *
 * Jobs run in their own in-memory Pi session, so without this the Telegram
 * chat agent never sees what the job told the user — replying to the message
 * reads as amnesia. Recording it:
 *
 *  - writes a `ChatMessage` row (assistant) so the web UI shows the same
 *    thread, and keeps the session from expiring between the job message and
 *    the reply (session expiry is driven by the latest message timestamp),
 *  - appends a custom message entry to the chat's Pi transcript, which the
 *    agent reads as conversation context (custom entries convert to a user
 *    message for the model).
 *
 * No-ops when the chat has no session yet (the user has never messaged the
 * bot) — there is nothing to attach the message to, and the reply-to context
 * injection covers that case.
 */
export async function recordTelegramJobOutput(params: {
  userId: string;
  telegramChatId: bigint;
  content: string;
}): Promise<void> {
  const { userId, telegramChatId, content } = params;
  if (!content.trim()) return;

  const account = await prisma.telegramAccount.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!account) return;

  const tgChat = await prisma.telegramChat.findUnique({
    where: {
      telegramAccountId_telegramChatId: {
        telegramAccountId: account.id,
        telegramChatId,
      },
    },
    select: { sessionId: true },
  });
  if (!tgChat) return;

  const { sessionId } = tgChat;

  await prisma.chatMessage.create({
    data: { sessionId, role: "assistant", content },
  });

  // New chat content — advance lastActivityAt so the session list sorts it
  // correctly and the chat's expiry window restarts.
  await prisma.chatSession
    .update({ where: { id: sessionId }, data: { lastActivityAt: new Date() } })
    .catch((err) => {
      console.error(`Failed to bump lastActivityAt for telegram session ${sessionId}:`, err);
    });

  // Append under the chat lock so it cannot interleave with an active run
  // writing to the same transcript file.
  await withChatLock(`${userId}:${telegramChatId}`, async () => {
    const sessionDir = path.join(getUploadsDir(), "pi_sessions", userId, sessionId);
    const manager = SessionManager.continueRecent(sessionDir, sessionDir);
    manager.appendCustomMessageEntry(
      JOB_OUTPUT_CUSTOM_TYPE,
      `[Telegram message sent to the user by an automated job]\n${content}`,
      false,
      { channel: "telegram" },
    );
  });
}
