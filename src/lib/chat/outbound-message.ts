import type { Message } from "@/components/chat/types";

/**
 * Placement and reconciliation of optimistic outbound messages.
 *
 * A message sent while the session is busy — Pi generating, or a manual
 * compaction holding the session — is queued server-side, so its optimistic
 * copy belongs in the composer's queue strip — never in the conversation.
 * Rendering it as a sent bubble first (which also pushes it behind the live
 * turn, replacing the streaming indicator with a bare "Thinking…" placeholder)
 * makes it flash as sent before it snaps into the queue.
 *
 * The POST response is the authority: it can disagree with the client's guess
 * (the connect-time view can be stale), so both placements have to reconcile
 * into the same end state.
 */

/** Where the optimistic copy of a just-sent message is rendered. */
export type OutboundPlacement = "conversation" | "queue";

/**
 * A busy session queues the message server-side, so it goes straight into the
 * queue strip. Otherwise it is prompted now and shows up in the conversation
 * immediately (the user must see their own message while the request is in
 * flight).
 */
export function placementForSend(busy: boolean): OutboundPlacement {
  return busy ? "queue" : "conversation";
}

/**
 * Swap a sent message's optimistic copy for its saved row, appending it when
 * the optimistic copy is not in the list (the send was placed in the queue, so
 * the conversation never showed it). Idempotent: a DB reload that already
 * delivered the saved row is not duplicated.
 */
export function settleSentMessage(
  messages: Message[],
  optimistic: Message,
  saved: Message,
): Message[] {
  if (!messages.some((m) => m.id === optimistic.id)) {
    return messages.some((m) => m.id === saved.id) ? messages : [...messages, saved];
  }
  return messages.map((m) => (m.id === optimistic.id ? saved : m));
}

/**
 * Put a queued message's saved row into the queue strip, keeping the position
 * the server gave it when an SSE `queue_update` published the row before the
 * POST response arrived (re-inserting would reorder it past messages queued
 * after it).
 */
export function settleQueuedMessage(
  queue: Message[],
  optimistic: Message,
  saved: Message,
): Message[] {
  const withoutOptimistic = queue.filter((m) => m.id !== optimistic.id);
  if (withoutOptimistic.some((m) => m.id === saved.id)) return withoutOptimistic;
  return [...withoutOptimistic, saved];
}

/** Drop local-only copies — the send failed, or the server owns them now. */
export function dropOptimistic(list: Message[], ...messages: Message[]): Message[] {
  const ids = new Set(messages.map((m) => m.id));
  return list.filter((m) => !ids.has(m.id));
}
