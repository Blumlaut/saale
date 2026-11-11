/**
 * The Telegram addendum to Saale's system prompt.
 *
 * Kept dependency-free so tests can import it without loading the processor
 * (and its Pi session/Prisma dependency tree).
 */

/**
 * Telegram-specific formatting addendum (appended to the system prompt).
 *
 * Output is sent with parse_mode MarkdownV2 (see client.ts), so the model
 * must be told to use Markdown. HTML tags would be escaped and shown as
 * literal text.
 */
export const TELEGRAM_FORMATTING_GUIDE = `

Telegram-specific guidelines:
- Keep messages readable at a glance. avoid long blocks of text.
- Format with Markdown: **bold**, *italic*, \`inline code\`, and \`\`\` fenced code blocks for multi-line code.
- Use "-" bullet points for lists.
- Never use HTML tags (<b>, <i>, <code>, etc.). they will not render and will show as literal text.
- Avoid excessive formatting. keep it clean and readable on mobile.`;
