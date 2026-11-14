/**
 * Structured metadata tools append to their result text.
 *
 * Each tool family writes its own `_saale*Meta` block as the last JSON object in
 * the result string. Both the transcript cards and the share redactor read
 * those blocks, so the scan lives here once instead of once per consumer.
 *
 * Client-safe: no server imports, no parsing of anything else in the result.
 */

/** Result keys the tools append their metadata under. */
const TOOL_META_KEYS = [
  "_saaleWebMeta",
  "_saaleMailMeta",
  "_saaleCalMeta",
  "_saaleInfraMeta",
  "_saaleImageMeta",
] as const;

export type ToolMetaKey = (typeof TOOL_META_KEYS)[number];

export interface ToolMetaBlock {
  key: ToolMetaKey;
  meta: Record<string, unknown>;
}

/**
 * Parse the metadata block a tool appended to its result text.
 *
 * The block is the last JSON object in the string, so the scan starts at the
 * key and walks back to its opening brace. Returns null when the tool appended
 * nothing, or when the block is malformed or truncated.
 */
export function extractToolMetaBlock(result: string | undefined): ToolMetaBlock | null {
  if (!result) return null;

  for (const key of TOOL_META_KEYS) {
    const keyIndex = result.lastIndexOf(`"${key}"`);
    if (keyIndex === -1) continue;

    const openBrace = result.lastIndexOf("{", keyIndex);
    if (openBrace === -1) continue;

    let depth = 0;
    for (let i = openBrace; i < result.length; i++) {
      if (result[i] === "{") depth++;
      else if (result[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(result.slice(openBrace, i + 1)) as Record<string, unknown>;
            const meta = parsed[key];
            if (meta && typeof meta === "object" && !Array.isArray(meta)) {
              return { key, meta: meta as Record<string, unknown> };
            }
          } catch (err) {
            console.error("Failed to parse a tool meta block:", err);
          }
          break;
        }
      }
    }
  }

  return null;
}

/** Where the agent writes what it renders, relative to the workspace root. */
export const GENERATED_IMAGE_DIR = "generated";

/**
 * The picture one tool call rendered, when it rendered one.
 *
 * The path comes from the stored result, so a caller can trust it as something
 * the render wrote rather than something a request asked for.
 */
export function renderedImagePath(result: string | undefined): string | undefined {
  const block = extractToolMetaBlock(result);
  if (block?.key !== "_saaleImageMeta") return undefined;

  const path = block.meta.path;
  if (typeof path !== "string" || !path.startsWith(`${GENERATED_IMAGE_DIR}/`)) return undefined;
  // A stored result is only as trustworthy as what wrote it, so nothing climbs
  // out of the folder the renders live in.
  return path.split("/").includes("..") ? undefined : path;
}

/** Every picture a turn rendered, in the order the calls ran. */
export function renderedImagePaths(toolCallsJson: string | null | undefined): string[] {
  if (!toolCallsJson) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallsJson);
  } catch (err) {
    console.error("Failed to parse a message's tool calls:", err);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((call: { result?: unknown }) =>
      renderedImagePath(typeof call?.result === "string" ? call.result : undefined),
    )
    .filter((path): path is string => path !== undefined);
}

/**
 * The metadata block as a typed shape.
 *
 * `T` is never validated. the block is written by our own tools, and every
 * caller narrows on its `type` discriminant before reading a field.
 */
export function extractToolMeta<T extends { type?: string }>(result: string | undefined): T | null {
  return (extractToolMetaBlock(result)?.meta as T | undefined) ?? null;
}
