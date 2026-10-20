/**
 * Reading a codemode script: which tools it reaches.
 *
 * A script calls tools through `tools`, keyed by the tool's codemode identifier
 * (`mail_send`, `mcp__docs__search`) or, when the name is not a valid
 * identifier, by the raw name (`tools["my-tool"]`). Both forms are read here.
 *
 * The source is the only record of a script's tool use. the calls it makes are
 * not assistant message content, so they are gone on reload. which is why the
 * transcript card and the approval gate read the same source through this same
 * module.
 *
 * This is a lexical read, not a parse: a name the source merely mentions (in a
 * string, in a comment, assigned to a variable and called later) counts as
 * reached. That is deliberate. the only way to be wrong is to cover a call that
 * never happens.
 */

import { toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";

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
   * duplicates. A key is an identifier or a raw tool name. only the registry
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

/**
 * Tool names the script's keys name.
 *
 * A key is the tool's codemode identifier (`mail_send`, `mcp__docs__search`) or
 * its raw name (`tools["my-tool"]`), and one string can be both. `my-tool`
 * becomes the identifier `my_tool`, which another tool may already be called
 * so a key resolves to every name it could mean. Covering a name the script
 * never calls costs nothing; missing one it does call is what puts a call the
 * user already approved back in front of them.
 *
 * Shared by every caller that has to decide what a script reaches: the chat
 * approval gate, the transcript card, and a watcher's tool grant. They must
 * agree. a script the gate reads one way and a grant reads another is exactly
 * the disagreement this module exists to make impossible.
 */
export function resolveReferencedTools(
  keys: readonly string[],
  callable: readonly string[],
): string[] {
  const namesByKey = new Map<string, string[]>();
  for (const name of callable) {
    for (const key of new Set([name, toCodemodeIdentifier(name)])) {
      const names = namesByKey.get(key);
      if (!names) namesByKey.set(key, [name]);
      else if (!names.includes(name)) names.push(name);
    }
  }

  const resolved = new Set<string>();
  for (const key of keys) {
    for (const name of namesByKey.get(key) ?? []) resolved.add(name);
  }
  return [...resolved];
}
