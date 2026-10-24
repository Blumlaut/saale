import type { Message } from "@/components/chat/types";

/**
 * Clear text a turn did not really write.
 *
 * Models routinely emit a text block holding a lone newline between tool
 * rounds, and the reasoning can come back blank. Either one renders as a
 * hollow bubble, or an empty thinking card in the step-by-step transcript.
 */
export function dropBlankText(message: Message): Message {
  const content = message.content.trim() ? message.content : "";
  const thinking = message.thinking?.trim() ? message.thinking : undefined;
  if (content === message.content && thinking === message.thinking) return message;
  return { ...message, content, thinking };
}
