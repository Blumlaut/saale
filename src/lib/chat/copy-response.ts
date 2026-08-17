import type { Message } from "@/components/chat/types";

/**
 * Combine the visible text of an assistant response group into a single
 * string for copy-to-clipboard: the `content` of every turn that has text,
 * joined by a blank line. Thinking blocks and tool calls are excluded.
 */
export function getAssistantCopyText(messages: Message[]): string {
  return messages
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join("\n\n");
}
