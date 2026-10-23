/**
 * Helpers for writing many rows without paying a round trip per row.
 *
 * Postgres caps a single statement at 65535 bind parameters, so an `in` list or
 * a `createMany` batch has to stay well under it. The sync paths (email,
 * calendar) use these to collapse thousands of per-row queries into a handful.
 */

/**
 * How many UIDs go into one `where: { uid: { in: [...] } }` existence lookup.
 * Far below the bind-parameter cap, and small enough to keep the statement
 * cheap to plan.
 */
export const IN_LIST_CHUNK_SIZE = 5000;

/** Split `items` into consecutive chunks of at most `size` entries. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
