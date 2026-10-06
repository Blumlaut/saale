/**
 * Quote-reply context for Telegram messages.
 *
 * Telegram includes the full replied-to message in the update, so when the
 * user quote-replies we can hand the agent the exact context — even when the
 * original was sent by a job (which lives outside the chat's Pi session) or
 * before a session rollover. Without this, replying to a job's message reads
 * to the agent as amnesia.
 */

export interface QuotedMessageContext {
  messageId: number;
  text: string;
  /** True when the quoted message was sent by the bot. */
  fromBot: boolean;
  fromName: string;
}

/** Longest quoted message replayed into the prompt — Telegram caps messages at 4096. */
const MAX_QUOTED_CHARS = 2000;

/** Extract the message a user is quote-replying to, if any. */
export function extractQuotedMessage(reply: unknown): QuotedMessageContext | undefined {
  if (!reply || typeof reply !== "object") return undefined;
  const r = reply as {
    message_id?: number;
    text?: string;
    caption?: string;
    from?: { first_name?: string; username?: string; is_bot?: boolean };
  };
  const text = r.text ?? r.caption;
  if (!text || typeof r.message_id !== "number") return undefined;
  return {
    messageId: r.message_id,
    text,
    fromBot: r.from?.is_bot === true,
    fromName: r.from?.first_name ?? r.from?.username ?? "unknown",
  };
}

/**
 * Build the prompt preamble that names the quoted message. Returns null when
 * there is nothing quoted, so callers can leave the prompt untouched.
 */
export function buildQuotedContext(quoted: QuotedMessageContext | undefined): string | null {
  if (!quoted) return null;
  const truncated =
    quoted.text.length > MAX_QUOTED_CHARS
      ? `${quoted.text.slice(0, MAX_QUOTED_CHARS)}…`
      : quoted.text;
  const source = quoted.fromBot ? "you (the assistant)" : `the user's contact ${quoted.fromName}`;
  return (
    `[The user is quote-replying to message #${quoted.messageId} in this Telegram chat, ` +
    `sent by ${source}]:\n<quoted_message>\n${truncated}\n</quoted_message>`
  );
}
