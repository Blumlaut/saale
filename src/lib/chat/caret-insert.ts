/**
 * Where a spoken sentence joins the draft.
 *
 * The transcript goes in at the caret like typed text, not as a quote: the
 * user speaks where they are writing in the sentence.
 */

/** Insert at the caret, spaced from whatever is already there. */
export function insertAtCaret(draft: string, text: string, cursor: number): string {
  const spoken = text.trim();
  if (!spoken) return draft;

  const pos = Math.max(0, Math.min(cursor, draft.length));
  const before = draft.slice(0, pos);
  const after = draft.slice(pos);

  const lead = before.length === 0 || /\s$/.test(before) ? "" : " ";
  const trail = after.length === 0 || /^\s/.test(after) ? "" : " ";

  return `${before}${lead}${spoken}${trail}${after}`;
}
