/**
 * "Finished responding" notifications.
 *
 * A chat turn can run for minutes, and the user has usually looked away by the
 * time it lands. The notification carries the start of the reply, so a glance
 * says whether it is worth going back for.
 *
 * Deliberately quiet in two cases: a run the user stopped (they know), and a
 * temporary chat (it is gone by the time they return). Delivery is left to the
 * service worker, which keeps the notification off a screen that is already
 * showing the reply.
 */
import { prisma } from "@/lib/db";
import { wasSessionAbortRequested } from "@/lib/pi/abort-request";
import { waitForPersistenceTeardown } from "@/lib/pi/session-persistence";
import { notifyUser } from "./notify";

/** A reply longer than this is cut. a notification body is one glance long. */
const MAX_BODY_LENGTH = 120;

/** The reply as one line: markdown whitespace is noise on a lock screen. */
function excerpt(content: string): string | null {
  const flat = content.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_BODY_LENGTH ? `${flat.slice(0, MAX_BODY_LENGTH - 1)}…` : flat;
}

/**
 * Notify a user that a chat turn finished. Never throws: a chat that answered
 * must not fail because a phone was unreachable.
 */
export async function notifyChatFinished(params: {
  userId: string;
  sessionId: string;
}): Promise<void> {
  const { userId, sessionId } = params;

  try {
    if (wasSessionAbortRequested(userId, sessionId)) return;

    // The reply is only on disk once the tracker has finished its saves.
    await waitForPersistenceTeardown(sessionId);

    const chat = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
      select: {
        title: true,
        temporary: true,
        projectId: true,
        project: { select: { name: true } },
        messages: {
          where: { role: "assistant" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { content: true },
        },
      },
    });
    if (!chat || chat.temporary) return;

    const body = excerpt(chat.messages[0]?.content ?? "") ?? chat.title;

    if (chat.projectId) {
      await notifyUser({
        userId,
        category: "coderDone",
        title: `${chat.project?.name ?? "Coder"} finished`,
        body,
        url: `/dashboard/coder/${chat.projectId}/${sessionId}`,
        tag: `chat-${sessionId}`,
      });
      return;
    }

    await notifyUser({
      userId,
      category: "chatDone",
      title: "Finished responding",
      body,
      url: `/dashboard/chat/${sessionId}`,
      tag: `chat-${sessionId}`,
    });
  } catch (err) {
    console.error(`Failed to notify that chat ${sessionId} finished:`, err);
  }
}
