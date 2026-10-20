/**
 * Display helpers for tool calls: readable argument formatting.
 *
 * `JSON.stringify` escapes newlines inside string values, so a multi-line shell
 * command or codemode script is stored. and rendered. as `"line1\nline2"`:
 * a `<pre>` shows the literal backslash-n. String values are therefore printed
 * verbatim (their real newlines, no quotes) and everything else keeps its JSON
 * form.
 *
 * Shared by the tool-call cards and the approval prompt so an approval shows
 * the same readable command the user will later see in the transcript.
 * (Reading a codemode script for the tools it reaches lives in
 * `@/lib/pi/codemode-script`, where the approval gate can share it.)
 */

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
