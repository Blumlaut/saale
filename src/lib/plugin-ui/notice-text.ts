/**
 * Pi writes some notices for a terminal, where `/mcp` is a command to type.
 * Saale keeps those settings on a page, so a hint naming a slash command is
 * replaced with where the same work happens here.
 */

const HINTS: [RegExp, string][] = [
  [/^Run \/mcp to fix\.$/gm, "Sign in from Settings → Integrations."],
  [/\brun \/mcp login \S+/gi, "sign in from Settings → Integrations"],
  [/\brun \/mcp\b/gi, "use Settings → Integrations"],
];

/** A plugin's notice, in Saale's own words. */
export function saaleNotice(message: string): string {
  return HINTS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    message,
  );
}
