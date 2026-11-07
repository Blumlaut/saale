/**
 * The rule for an instance-owned row beside an account's own.
 *
 * An admin writes shared resources once and every account gets them, so a
 * resource has two sources. Both features resolve the same way: the account's
 * own row wins a name clash, and the shared row is not offered at all.
 *
 * Pure, so the settings screens and the chat both read the same answer.
 */

/**
 * Merge the instance's rows with the account's own.
 *
 * The account's rows come first and own their names outright: a shared row whose
 * name one of them already answers to is dropped, because two rows of one name
 * would be one entry the user cannot tell apart (and, for an MCP server, tool
 * names that collide). `shared` says which side a row came from.
 */
export function mergeOwnedRows<T extends { name: string }>(options: {
  own: readonly T[];
  shared: readonly T[];
  /**
   * How two names are compared. The default is the name itself; MCP passes
   * `mcpNameKey`, which folds dashes and underscores into one character.
   */
  keyOf?: (row: T) => string;
}): Array<T & { shared: boolean }> {
  const keyOf = options.keyOf ?? ((row: T) => row.name);
  const merged: Array<T & { shared: boolean }> = [];
  const taken = new Set<string>();

  for (const [rows, shared] of [
    [options.own, false],
    [options.shared, true],
  ] as const) {
    for (const row of rows) {
      const key = keyOf(row);
      if (taken.has(key)) continue;
      taken.add(key);
      merged.push({ ...row, shared });
    }
  }

  return merged;
}
