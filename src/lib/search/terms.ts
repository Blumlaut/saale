/**
 * Query parsing for the postgres matcher in `query.ts`.
 *
 * A query is split into terms that are AND'd: every term has to be found
 * somewhere in the row. Each term then matches through up to three arms, which
 * cover different ways a user half-remembers a word:
 *
 * - substring: `ILIKE '%term%'` catches a fragment of a word ("invoic").
 * - full text: a prefix tsquery catches word forms ("invoices" for "invoice").
 * - trigrams: word similarity catches a misspelling ("invoce", "reciept").
 *
 * The trigram arm only applies to terms of at least `FUZZY_MIN_LENGTH`
 * characters. Short terms have too few trigrams to tell apart: "car" scores
 * 0.75 against "card".
 */

/** Shortest term worth a trigram comparison. */
export const FUZZY_MIN_LENGTH = 5;

/**
 * Word similarity a term needs before it counts as the same word. Measured on
 * real subjects: misspellings land at 0.45-0.7, unrelated words at or below
 * 0.33.
 */
export const FUZZY_THRESHOLD = 0.4;

/** Words per query. More than this and the SQL grows arms for no gain. */
export const MAX_TERMS = 6;

/** Longer than any word we care about, and keeps ILIKE patterns bounded. */
export const MAX_TERM_LENGTH = 64;

export interface SearchTerm {
  /** Lowercased term as typed, used for trigram comparison. */
  text: string;
  /** `%term%` with LIKE metacharacters escaped, for the substring arm. */
  like: string;
  /** Prefix tsquery such as `invoic:*`, or null when the term has no word characters. */
  tsquery: string | null;
  /** Whether the trigram arm applies. */
  fuzzy: boolean;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Escape a LIKE value for a raw SQL statement. */
export function likePattern(term: string): string {
  return `%${escapeLike(term)}%`;
}

/**
 * A prefix tsquery for one term, or null when nothing searchable is left.
 * `to_tsquery` has its own syntax, so everything but letters and digits goes:
 * a stray `&` or `(` in a term would otherwise be a parse error.
 */
export function termTsquery(term: string): string | null {
  const word = term.replace(/[^\p{L}\p{N}]+/gu, "");
  return word.length > 0 ? `${word}:*` : null;
}

export function parseSearchTerms(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const seen = new Set<string>();

  for (const raw of query.toLowerCase().split(/\s+/)) {
    const text = raw.slice(0, MAX_TERM_LENGTH);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    terms.push({
      text,
      like: likePattern(text),
      tsquery: termTsquery(text),
      fuzzy: text.length >= FUZZY_MIN_LENGTH && /\p{L}/u.test(text),
    });
    if (terms.length === MAX_TERMS) break;
  }

  return terms;
}

/** Every term joined into one AND'd tsquery, or null when none is usable. */
export function combinedTsquery(terms: readonly SearchTerm[]): string | null {
  const parts = terms.map((term) => term.tsquery).filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" & ") : null;
}

/** True when at least one term needs the trigram threshold lowered. */
export function needsTrigramArm(terms: readonly SearchTerm[]): boolean {
  return terms.some((term) => term.fuzzy);
}
