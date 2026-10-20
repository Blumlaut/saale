import type { Message } from "@/components/chat/types";

/**
 * Group a flat message list into renderable units:
 * - user/system messages → standalone user bubbles
 * - compaction messages → standalone compaction cards
 * - assistant messages → one group per generation turn: the root turn plus
 *   every consecutive child turn sharing its `parentMessageId` (multi-turn
 *   runs render as a single bubble with one avatar and one timestamp)
 */

export type MessageGroup =
  | { type: "user"; message: Message }
  | { type: "assistant-group"; messages: Message[] }
  | { type: "compaction"; message: Message };

export function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "user" || msg.role === "system") {
      groups.push({ type: "user", message: msg });
      i++;
    } else if (msg.role === "compaction") {
      groups.push({ type: "compaction", message: msg });
      i++;
    } else if (msg.role === "assistant") {
      // Collect this message and all consecutive child turns of the same run.
      const rootId = msg.parentMessageId || msg.id;
      const turnMessages: Message[] = [msg];
      i++;
      while (i < messages.length) {
        const next = messages[i]!;
        if (next.role === "assistant" && next.parentMessageId === rootId) {
          turnMessages.push(next);
          i++;
        } else {
          break;
        }
      }
      groups.push({ type: "assistant-group", messages: turnMessages });
    } else {
      // Unknown role. skip defensively.
      i++;
    }
  }

  return groups;
}
