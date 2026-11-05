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
 * snapshot reverts the UI to the empty state until the generation starts
 * the "sent message flashes, then the Start a conversation placeholder"
 * regression.
 *
 * Ordering: the merge keeps the server's conversation order (`createdAt`) and
 * slots the live turns into it. A live turn carries the server's turn start
 * (see `turn_start`), which is also the timestamp its DB row gets, so a
 * message delivered into the run mid-turn. a queued message pushed with "send
 * now", steered into the agent. lands after the turn it interrupted instead
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
 * its `savedAt` (see `MergeOptions`) explains the absence. anything else the
 * snapshot lacks is really gone.
 */
export interface MergeOptions {
  /**
   * The client clock when the snapshot was requested. A turn saved at or after
   * that moment cannot be in it, however fresh the response looks, so it is
   * kept even though the snapshot lacks it.
   */
  requestedAt?: number;
  /**
   * The oldest row in the snapshot. The transcript arrives one page at a time,
   * so everything the client holds below this row came from an earlier page and
   * belongs on screen above the snapshot.
   */
  pageStart?: { id: string; createdAt: string } | undefined;
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
  const live = prevMessages.filter(isLive);
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
  // Live turns and optimistic messages have their own rule below, and a live
  // turn is older than the page whenever the page is one row of what a run
  // wrote. Holding one here as well would render it twice.
  const earlierPages = options.pageStart
    ? prevMessages.filter(
        (m) => !snapshotIds.has(m.id) && !isLive(m) && isOlderThan(m, options.pageStart!),
      )
    : [];
  return [...earlierPages, ...ordered, ...live.filter(isTempUserMessage)];
}

/**
 * Put a page the user asked for above what is already loaded.
 *
 * The page comes from `?before=`, so it is older than the oldest message on
 * screen; an id already held is dropped in case a reload landed in between.
 */
export function prependOlderMessages(older: Message[], prevMessages: Message[]): Message[] {
  const held = new Set(prevMessages.map((m) => m.id));
  const fresh = older.filter((m) => !held.has(m.id));
  return fresh.length === 0 ? prevMessages : [...fresh, ...prevMessages];
}

/** Whether `message` sits below the row a page starts at, in transcript order. */
function isOlderThan(message: Message, start: { id: string; createdAt: string }): boolean {
  const at = Date.parse(message.createdAt) || 0;
  const boundary = Date.parse(start.createdAt) || 0;
  if (at !== boundary) return at < boundary;
  // Rows written in the same millisecond: the server breaks the tie by id.
  return message.id < start.id;
}

/** A message that exists only on the client: in-flight tokens, or an unsent send. */
function isLive(message: Message): boolean {
  return isStreamingMessage(message) || isTempUserMessage(message);
}

function byCreatedAt(a: Message, b: Message): number {
  // `|| 0`: an unparseable timestamp sorts first instead of poisoning the
  // comparison with NaN.
  return (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
}
