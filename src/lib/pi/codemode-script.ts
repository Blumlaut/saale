/**
 * Reading a codemode script: which tools it reaches.
 *
 * A script calls tools through `tools`, keyed by the tool's codemode identifier
 * (`mail_send`, `mcp__docs__search`) or, when the name is not a valid
 * identifier, by the raw name (`tools["my-tool"]`). Both forms are read here.
 *
 * The source is the only record of a script's tool use — the calls it makes are
 * not assistant message content, so they are gone on reload — which is why the
 * transcript card and the approval gate read the same source through this same
 * module.
 *
 * This is a lexical read, not a parse: a name the source merely mentions (in a
 * string, in a comment, assigned to a variable and called later) counts as
 * reached. That is deliberate — the only way to be wrong is to cover a call that
 * never happens.
 */

/**
 * A tool the script names: `tools.<key>` or `tools["<key>"]`, with the
 * whitespace JavaScript allows around the dot or bracket.
 */
const TOOL_REFERENCE = /\btools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["']([^"']+)["']\s*\])/g;

/**
 * Reaching a tool the source does not name: indexing `tools` with a computed
 * key, or looking names up in the catalog. Either one means the keys read above
 * are not the whole story.
 */
const DYNAMIC_REFERENCE = /\btools\s*\[(?!\s*["'])|(?:\bALL_TOOLS\b|\bsearchTools\b)/;

export interface ScriptToolReferences {
  /**
   * Keys the script indexes `tools` with, in first-use order and without
   * duplicates. A key is an identifier or a raw tool name — only the registry
   * knows which tool either one means (see the codemode approval gate).
   */
  keys: string[];
  /** The script can reach tools its source does not name. */
  dynamic: boolean;
}

/** The tools a codemode script reaches. */
export function readScriptToolReferences(code: string): ScriptToolReferences {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const match of code.matchAll(TOOL_REFERENCE)) {
    const key = match[1] ?? match[2];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return { keys, dynamic: DYNAMIC_REFERENCE.test(code) };
}
