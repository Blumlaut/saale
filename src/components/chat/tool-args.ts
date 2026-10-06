/**
 * Display helpers for tool calls: readable argument formatting, and parsing a
 * codemode script for the tools it calls.
 *
 * `JSON.stringify` escapes newlines inside string values, so a multi-line shell
 * command or codemode script is stored — and rendered — as `"line1\nline2"`:
 * a `<pre>` shows the literal backslash-n. String values are therefore printed
 * verbatim (their real newlines, no quotes) and everything else keeps its JSON
 * form.
 *
 * Shared by the tool-call cards and the approval prompt so an approval shows
 * the same readable command the user will later see in the transcript.
 */

/** `tools.<name>(` calls in a codemode script. */
const TOOL_CALL_PATTERN = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Tool names a codemode script calls, in first-use order.
 *
 * The transcript only records the `codemode` call itself — the individual calls
 * a script makes are not assistant message content, so they exist only as live
 * stream events and are gone on reload. Reading them off the script (which *is*
 * recorded, in `args.code`) is the only way to tell the user what a past script
 * did.
 */
export function extractScriptToolNames(code: string): string[] {
  const names = new Set<string>();
  for (const match of code.matchAll(TOOL_CALL_PATTERN)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export interface FormatToolArgsOptions {
  /** Only the first N arguments (the approval prompt shows a short preview). */
  maxEntries?: number;
  /** JSON indent for non-string values; 0 keeps them on one line. */
  indent?: number;
  /** Inserted between arguments. */
  separator?: string;
}

export function formatToolArgs(
  args: Record<string, unknown>,
  options: FormatToolArgsOptions = {},
): string {
  const { maxEntries, indent = 2, separator = "\n\n" } = options;
  const entries = Object.entries(args);
  const shown = maxEntries === undefined ? entries : entries.slice(0, maxEntries);
  return shown.map(([key, value]) => `${key}: ${formatArgValue(value, indent)}`).join(separator);
}

function formatArgValue(value: unknown, indent: number): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  // `JSON.stringify` returns undefined for values it cannot serialize (a
  // function or symbol in args). Fall back to String() so nothing prints
  // "undefined" as a serialization failure.
  return JSON.stringify(value, null, indent) ?? String(value);
}
