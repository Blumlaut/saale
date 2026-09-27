/**
 * Quote insertion for the chat composer.
 *
 * A quoted selection becomes a markdown blockquote (`> ` per line) so the
 * model can distinguish the referenced passage from the question. The
 * returned cursor sits right after the quote, so the user continues typing
 * their question on the following line.
 */

export interface QuoteInsertion {
  value: string;
  cursor: number;
}

/** Build the blockquote text for a selection — `> ` per line, `>` for blanks. */
export function buildQuoteBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * Insert a quoted block at the given caret position. Existing text is kept
 * on its own lines: a blank line separates the quote from surrounding
 * content whenever there is any (unless one is already there).
 */
export function insertQuote(draft: string, quote: string, cursor: number): QuoteInsertion {
  const pos = Math.max(0, Math.min(cursor, draft.length));
  const block = buildQuoteBlock(quote);
  if (!block) return { value: draft, cursor: pos };

  const before = draft.slice(0, pos);
  const after = draft.slice(pos);

  const prefix =
    before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix =
    after.length === 0
      ? "\n"
      : after.startsWith("\n\n")
        ? ""
        : after.startsWith("\n")
          ? "\n"
          : "\n\n";

  const value = `${before}${prefix}${block}${suffix}${after}`;
  return { value, cursor: value.length - after.length };
}
