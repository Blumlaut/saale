/**
 * Tool result normalization for chat streaming.
 *
 * Pi custom tools return `{ content: [{ type: "text", text: "..." }] }`.
 * This extracts the text content instead of JSON-stringifying the whole object,
 * which would double-encode the content.
 */

/** An image attachment ready for the LLM (base64-encoded, read from disk). */
export interface ImageContent {
  type: "image";
  data: string; // base64-encoded image data
  mimeType: string; // e.g. "image/png"
}

/**
 * Normalize a tool execution result to a plain text string.
 *
 * @param result - The raw result from a tool's execute() function or from a `tool_execution_end` event.
 * @returns The normalized text string to store in the DB and replay as toolResult content.
 *
 * @example
 * ```ts
 * // Tool returns structured result
 * normalizeToolResult({ content: [{ type: "text", text: "hello" }] })
 * // → "hello"
 *
 * // Already a string (e.g. from an error path)
 * normalizeToolResult("error message")
 * // → "error message"
 *
 * // Fallback for unexpected shapes
 * normalizeToolResult({ foo: 42 })
 * // → '{"foo":42}'
 * ```
 */
export function normalizeToolResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as Record<string, unknown>).content)
  ) {
    const content = (result as Record<string, unknown>).content as unknown[];
    return content
      .filter(
        (c) =>
          c &&
          typeof c === "object" &&
          "type" in c &&
          (c as Record<string, unknown>).type === "text",
      )
      .map((c) => String((c as Record<string, unknown>).text ?? ""))
      .join("");
  }
  return JSON.stringify(result);
}
