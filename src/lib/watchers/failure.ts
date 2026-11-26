/**
 * Telling someone an automation's tick failed.
 *
 * A failed tick records itself in the automation's log and stops there. The chat
 * the fire was meant for never sees it, so neither the agent working in that
 * conversation nor the user learns the report was lost, and the next tick looks
 * like the first one that mattered.
 *
 * A failure is announced once, when it starts or changes shape. An automation
 * that fails every tick for an afternoon would otherwise fill the bell with the
 * same sentence.
 */

import { prisma } from "@/lib/db";
import { appendChatMessage } from "@/lib/chat/append-message";
import { notifyUser } from "@/lib/notifications/notify";
import { appendSessionNote } from "@/lib/pi/session-notes";
import { publishSessionEvent } from "@/lib/pi/session-events";
import type { TickOutcome } from "./tick";

/** Custom-entry type of the note the agent reads. */
export const AUTOMATION_FAILURE_NOTE_TYPE = "automation_failure";

/** Statuses that mean the fire never landed. */
const FAILED_STATUSES: ReadonlySet<TickOutcome["status"]> = new Set(["error", "blocked"]);

/** What the notice says when the tick could not say why. */
const UNSTATED_REASON = "It failed without saying why";

/** The automation fields failure reporting reads. */
export interface FailureTarget {
  id: string;
  userId: string;
  name: string;
  /** The chat a fire reports into. */
  sessionId: string | null;
  /** The chat the automation was created from. */
  originSessionId: string | null;
}

/** The line the chat and the bell both carry. */
export function failureText(name: string, reason: string): string {
  const said = reason.trim().replace(/\.$/, "");
  return `Automation "${name}" failed: ${said}. What it would have reported never arrived.`;
}

/**
 * Whether this tick earns a notice.
 *
 * `previousError` is the automation's stored `lastError` from before this tick,
 * so a run of identical failures is one notice and a new failure is another.
 */
export function failureNoticeEarned(previousError: string | null, outcome: TickOutcome): boolean {
  if (!FAILED_STATUSES.has(outcome.status)) return false;
  return (outcome.reason ?? UNSTATED_REASON) !== previousError;
}

/**
 * Put the failure in the chat it was meant for, and ring the user's bell.
 *
 * Never throws: the tick is already recorded, and a notification that could not
 * be written must not turn into a second failed tick.
 */
export async function announceTickFailure(options: {
  watcher: FailureTarget;
  outcome: TickOutcome;
}): Promise<void> {
  const { watcher, outcome } = options;
  const text = failureText(watcher.name, outcome.reason ?? UNSTATED_REASON);

  await noteInChat(watcher, text).catch((err) => {
    console.error(`Failed to note automation ${watcher.id}'s failure in its chat:`, err);
  });

  await notifyUser({
    userId: watcher.userId,
    category: "automation",
    title: `Automation "${watcher.name}" failed`,
    body: outcome.reason ?? UNSTATED_REASON,
    url: `/dashboard/jobs/automations?id=${watcher.id}`,
    // One tag per automation: a later failure replaces the earlier notice
    // instead of stacking on the lock screen.
    tag: `automation-${watcher.id}`,
    inApp: true,
  });
}

/**
 * Write the failure into the chat: a card the user sees, and a note the agent
 * reads. The two are separate stores, and the failure belongs in both.
 */
async function noteInChat(watcher: FailureTarget, text: string): Promise<void> {
  const sessionId = watcher.sessionId ?? watcher.originSessionId;
  if (!sessionId) return;

  const own = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: watcher.userId },
    select: { id: true },
  });
  if (!own) {
    console.error(`Automation ${watcher.id} reports into a chat that is not its owner's`);
    return;
  }

  await appendChatMessage({ sessionId, userId: watcher.userId, role: "system", content: text });

  await appendSessionNote({
    userId: watcher.userId,
    sessionId,
    type: AUTOMATION_FAILURE_NOTE_TYPE,
    text,
  });
  await publishSessionEvent(sessionId, "messages_changed", {});
}
