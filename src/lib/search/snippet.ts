/**
 * A short excerpt around the part of the text that matched.
 *
 * A result that shows the head of a body when the match sits three paragraphs
 * down tells the reader nothing, and the agent then asks for more rows to find
 * out. Showing the matched words answers it in the same row.
 */

/** The match sits about a third of the way into the excerpt. */
const MATCH_POSITION = 3;

export function snippetAround(text: string, query: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;

  const lower = flat.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const at = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);

  const start = at <= 0 ? 0 : Math.max(0, at - Math.floor(length / MATCH_POSITION));
  const end = start + length;

  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
