/** A slash command parsed out of a message body. */
export interface ParsedCommand {
  /** Command name, lowercased, without the slash or the `@bot` suffix. */
  name: string;
  /** Everything after the name, trimmed. */
  args: string;
}

/**
 * `/name`, `/name@BotName`, `/name args`, `/name@BotName args`.
 *
 * The optional `@BotName` suffix is only valid immediately after the name, so
 * a path such as `/dashboard/chat` does not parse as a command.
 */
const COMMAND_PATTERN = /^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i;

/**
 * Parse a message body as a slash command, or return null when it is not one.
 *
 * Telegram appends `@BotName` when several bots share a chat; stripping that
 * here is what lets both surfaces reach the registry with the same name.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(text.trim());
  const name = match?.[1];
  if (!name) return null;
  return { name: name.toLowerCase(), args: (match[2] ?? "").trim() };
}
