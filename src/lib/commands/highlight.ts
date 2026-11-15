/**
 * What a command line is made of, for the composer's highlight.
 *
 * The textarea keeps its own text; this describes the same characters in
 * pieces, so a chip can sit behind the argument names and their values without
 * the composer becoming a rich-text editor. Concatenating the pieces gives the
 * text back exactly, which is what lets a mirror render them in place.
 */

import { argumentLabelPattern, spelledArguments } from "./arguments";
import { readCommandDraft } from "./composer";
import { getCommandMeta } from "./catalog";

/** One run of characters, and what it is doing in the line. */
export interface CommandToken {
  kind: "command" | "label" | "value" | "plain";
  text: string;
}

/**
 * Split a composer value into highlighted runs.
 *
 * Nothing to highlight when the value is not a command the catalog knows: an
 * unknown `/foo` is an ordinary message and must look like one.
 */
export function commandTokens(text: string): CommandToken[] {
  const draft = readCommandDraft(text);
  const meta = draft ? getCommandMeta(draft.name) : undefined;
  if (!draft || !meta) return [];

  // Leading whitespace is kept as its own run so the mirror still matches.
  const slash = text.indexOf("/");
  const nameEnd = slash + 1 + draft.name.length;
  const tokens: CommandToken[] = [];
  if (slash > 0) tokens.push({ kind: "plain", text: text.slice(0, slash) });
  tokens.push({ kind: "command", text: text.slice(slash, nameEnd) });
  const declared = spelledArguments(meta);
  if (declared.length === 0) {
    if (text.length > nameEnd) tokens.push({ kind: "plain", text: text.slice(nameEnd) });
    return tokens;
  }

  const rest = text.slice(nameEnd);
  const pattern = argumentLabelPattern(declared.map((arg) => arg.name));
  const matches = [...rest.matchAll(pattern)];
  let cursor = 0;

  for (const [index, match] of matches.entries()) {
    const labelStart = match.index;
    const labelEnd = match.index + match[0].length;
    const nextStart = matches[index + 1]?.index ?? rest.length;

    // The space before the label belongs to the gap, not to the chip.
    const gapEnd = labelStart + (match[1]?.length ?? 0);
    if (gapEnd > cursor) tokens.push({ kind: "plain", text: rest.slice(cursor, gapEnd) });
    tokens.push({ kind: "label", text: rest.slice(gapEnd, labelEnd) });
    const value = rest.slice(labelEnd, nextStart);
    if (value) tokens.push({ kind: "value", text: value });
    cursor = nextStart;
  }

  if (cursor < rest.length) tokens.push({ kind: "plain", text: rest.slice(cursor) });
  return tokens;
}
