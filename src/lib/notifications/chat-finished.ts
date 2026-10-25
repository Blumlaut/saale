/**
 * "Finished responding" notifications.
 *
 * A chat turn can run for minutes, and the user has usually looked away by the
 * time it lands. The notification names the conversation so a glance says which
 * one to go back to.
 *
 * Deliberately quiet in two cases: a run the user stopped (they know), and a
 * temporary chat (it is gone by the time they return). Delivery is left to the
 * service worker, which keeps the notification off a screen that is already
 * showing the reply.
 */
import { prisma } from "@/lib/db";
import { wasSessionAbortRequested } from "@/lib/pi/abort-request";
import { notifyUser } from "./notify";

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

    const chat = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId },
      select: {
        title: true,
        temporary: true,
        projectId: true,
        project: { select: { name: true } },
      },
    });
    if (!chat || chat.temporary) return;

    if (chat.projectId) {
      await notifyUser({
        userId,
        category: "coderDone",
        title: `${chat.project?.name ?? "Coder"} finished`,
        body: chat.title,
        url: `/dashboard/coder/${chat.projectId}/${sessionId}`,
        tag: `chat-${sessionId}`,
      });
      return;
    }

    await notifyUser({
      userId,
      category: "chatDone",
      title: "Finished responding",
      body: chat.title,
      url: `/dashboard/chat/${sessionId}`,
      tag: `chat-${sessionId}`,
    });
  } catch (err) {
    console.error(`Failed to notify that chat ${sessionId} finished:`, err);
  }
}
