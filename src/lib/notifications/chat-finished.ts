/**
 * "Finished responding" notifications.
 *
 * A chat turn can run for minutes, and the user has usually looked away by the
 * time it lands. The notification carries the start of the reply, so a glance
 * says whether it is worth going back for.
 *
 * Deliberately quiet in three cases: a run the user stopped (they know), a
 * temporary chat (it is gone by the time they return), and a reply that landed
 * on a screen the user was looking at. The last one is why this waits before
 * sending: the open chat reports itself when an answer arrives, against a
 * timestamp kept per user, so a laptop reading the reply keeps a phone in a
 * pocket quiet. A report from before the turn finished does not count. The
 * service worker drops the push as a second line of defence when the app is
 * visible on the device that receives it.
 */
import { prisma } from "@/lib/db";
import { wasSessionAbortRequested } from "@/lib/pi/abort-request";
import { waitForPersistenceTeardown } from "@/lib/pi/session-persistence";
import { getChatSeenAt } from "@/lib/redis";
import { notifyUser } from "./notify";

/** A reply longer than this is cut. a notification body is one glance long. */
const MAX_BODY_LENGTH = 120;

/**
 * How long to wait for the chat to turn up on the user's screen before the push
 * goes out. Long enough for the client to render the answer and say so, short
 * enough that a device away from the desk hears about the reply promptly.
 */
const SEEN_GRACE_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

    const finishedAt = Date.now();

    // The reply is only on disk once the tracker has finished its saves. The
    // grace period runs alongside them, and the seen timestamp is read after it.
    await Promise.all([waitForPersistenceTeardown(sessionId), sleep(SEEN_GRACE_MS)]);
    const seenAt = await getChatSeenAt(userId, sessionId);
    if (seenAt !== null && seenAt >= finishedAt) return;

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
