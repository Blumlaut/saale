import type { Message } from "@/components/chat/types";
import { isStreamingMessage, isTempUserMessage } from "./message-factories";

/**
 * Merge a DB snapshot with client-side-only "live" messages.
 *
 * The DB is the source of truth for saved messages, but two kinds of messages
 * exist ONLY in the client's state and must survive any reload:
 * - streaming assistant turns with in-flight tokens / running tool calls
 *   that the session tracker hasn't saved to the DB yet
 * - optimistic user messages whose POST /messages is still in flight (their
 *   real ID arrives in the response)
 *
 * A DB snapshot fetched BEFORE a POST committed is stale: it lacks the
 * just-sent user message. Without preserving the temp copy, applying such a
 * snapshot reverts the UI to the empty state until the generation starts —
 * the "sent message flashes, then the Start a conversation placeholder"
 * regression.
 *
 * Ordering: the merge keeps the server's conversation order (`createdAt`) and
 * slots the live turns into it. A live turn carries the server's turn start
 * (see `turn_start`), which is also the timestamp its DB row gets, so a
 * message delivered into the run mid-turn — a queued message pushed with "send
 * now", steered into the agent — lands after the turn it interrupted instead
 * of above it. Appending live turns blindly would show exactly that inversion
 * to anyone watching (and a reload mid-run would keep showing it).
 *
 * Optimistic user messages are exempt from the ordering: their timestamp comes
 * from the browser clock, and a clock that lags the server's must never place
 * a just-sent message above the reply it follows. They always render last,
 * which is where a message the user just submitted belongs.
 *
 * Temp messages with other roles (e.g. the compaction placeholder) are NOT
 * preserved: those flows manage their own optimistic state and replacing it
 * with the DB copy on success is the intended outcome.
 *
 * A DB row inherits the `turnId` of the live bubble it replaces. The tag is how
 * the reducer recognises a turn it already has (see `stream-reducer`), so
 * dropping it here would let a replayed event for that turn add a second copy
 * of a message sitting on screen.
 *
 * A turn saved while the snapshot was in flight is the same problem seen from
 * the start: `message_saved` renamed the bubble to a row the server had not
 * committed when it read the response, so the snapshot does not have it. Only
 * its `savedAt` (see `MergeOptions`) explains the absence — anything else the
 * snapshot lacks is really gone.
 */
export interface MergeOptions {
  /**
   * The client clock when the snapshot was requested. A turn saved at or after
   * that moment cannot be in it, however fresh the response looks, so it is
   * kept even though the snapshot lacks it.
   */
  requestedAt?: number;
}

export function mergeMessagesWithLive(
  dbMessages: Message[],
  prevMessages: Message[],
  options: MergeOptions = {},
): Message[] {
  const turnByMessageId = new Map(
    prevMessages.flatMap((m) => (m.turnId ? [[m.id, m.turnId] as const] : [])),
  );
  const tagged = dbMessages.map((m) => {
    const turnId = turnByMessageId.get(m.id);
    return turnId && !m.turnId ? { ...m, turnId } : m;
  });
  const live = prevMessages.filter((m) => isStreamingMessage(m) || isTempUserMessage(m));
  const snapshotIds = new Set(dbMessages.map((m) => m.id));
  const savedWhileLoading = prevMessages.filter(
    (m) =>
      !snapshotIds.has(m.id) &&
      options.requestedAt !== undefined &&
      m.savedAt !== undefined &&
      m.savedAt >= options.requestedAt,
  );
  const ordered = [...tagged, ...live.filter(isStreamingMessage), ...savedWhileLoading].sort(
    byCreatedAt,
  );
  return [...ordered, ...live.filter(isTempUserMessage)];
}

function byCreatedAt(a: Message, b: Message): number {
  // `|| 0`: an unparseable timestamp sorts first instead of poisoning the
  // comparison with NaN.
  return (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
}
