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
 * Temp messages with other roles (e.g. the compaction placeholder) are NOT
 * preserved: those flows manage their own optimistic state and replacing it
 * with the DB copy on success is the intended outcome.
 */
export function mergeMessagesWithLive(dbMessages: Message[], prevMessages: Message[]): Message[] {
  return [
    ...dbMessages,
    ...prevMessages.filter((m) => isStreamingMessage(m) || isTempUserMessage(m)),
  ];
}
