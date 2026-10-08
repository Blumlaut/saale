/**
 * Tools that return a value.
 *
 * A tool result has two readers with different needs. The model reads `content`,
 * text that carries UI metadata and, for some tools, an echo of the call's own
 * arguments. A programmatic caller — a codemode script, a watcher tick — reads
 * `structuredContent`, the value the tool actually computed.
 *
 * Pi hands `structuredContent` to programmatic callers only for tools that
 * declare an `outputSchema`, and renders that schema into the codemode
 * declarations the model reads. So every tool built here declares one. A tool
 * that had no schema would hand scripts its model-facing text instead: text a
 * script has to parse, and whose own arguments are echoed back, which is how a
 * script ends up matching a marker against its own query.
 *
 * Both readers are therefore served from one object: the value a tool returns is
 * the text the model reads and the object a script receives.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageContent, JsonValue, TextContent } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * What a tool computes, plus how the model should see it.
 *
 * `value` is what a script receives and is the only required part. The rest
 * shapes the text: `text` replaces the default rendering of the value, and
 * `content` adds blocks beside it (an image read is an attachment).
 */
export interface ToolOutcome<TValue, TDetails> {
  value: TValue;
  /** Model-facing text. Defaults to the value as pretty-printed JSON. */
  text?: string;
  /** Blocks to place after the text, before the metadata. */
  content?: readonly (TextContent | ImageContent)[];
  /**
   * UI metadata, appended to the text as its own JSON document — the tool's
   * `_saale*Meta` block, key included. Never part of the value: it names what
   * the UI draws, not what the tool found, and absent fields are simply absent
   * once it is serialized.
   */
  meta?: Record<string, unknown>;
  /** Details for the UI and logs. */
  details?: TDetails;
}

/** The execute arguments of a tool, taken from Pi's own definition type. */
type ToolExecuteArgs<TParams extends TSchema, TDetails> = Parameters<
  ToolDefinition<TParams, TDetails>["execute"]
>;

type StructuredToolSpec<TParams extends TSchema, TDetails, TOutput extends TSchema> = Omit<
  ToolDefinition<TParams, TDetails>,
  "parameters" | "outputSchema" | "execute"
> & {
  parameters: TParams;
  /** Schema of `value`. Rendered into the codemode declarations, and checks the value. */
  outputSchema: TOutput;
  execute: (
    ...args: ToolExecuteArgs<TParams, TDetails>
  ) => Promise<ToolOutcome<Static<TOutput>, TDetails>>;
};

/**
 * Build a tool whose result is a value.
 *
 * `outputSchema` describes what the tool returns: it types `value` here,
 * documents the result for script authors, and is what makes Pi hand the value
 * over instead of the text. Every tool result goes through this, so the pair
 * cannot drift and no tool can quietly return text only.
 */
export function defineStructuredTool<
  TParams extends TSchema,
  TDetails = undefined,
  TOutput extends TSchema = TSchema,
>(spec: StructuredToolSpec<TParams, TDetails, TOutput>) {
  const { outputSchema, execute, ...rest } = spec;

  return defineTool({
    ...rest,
    outputSchema,
    execute: async (...args: ToolExecuteArgs<TParams, TDetails>) => {
      const outcome = await execute(...args);
      // A round trip through JSON is what a programmatic caller receives anyway
      // (Pi serializes the value across the sandbox boundary), and it is the only
      // way the value can be typed as one: an interface-typed payload is not
      // assignable to JsonValue, though it serializes to one. It also normalizes
      // Dates to strings and drops undefined, so the value matches what the text
      // shows and what `outputSchema` declares.
      const value = JSON.parse(JSON.stringify(outcome.value)) as JsonValue;

      const text = outcome.text ?? JSON.stringify(value, null, 2);
      const blocks = outcome.content ?? [];
      const content: (TextContent | ImageContent)[] = [];

      // An empty text block adds nothing to a result that carries blocks of its
      // own — a remote image read has no text to show — but a result needs at
      // least one block to be a result.
      if (text !== "" || blocks.length === 0) {
        content.push({ type: "text", text });
      }
      content.push(...blocks);

      if (outcome.meta) {
        // Appended to the text the model already reads, which is where a tool
        // has always put it — one block per result, not two. A result whose text
        // is an attachment rather than prose gets the block on its own, and the
        // leading newline is what the transcript's separator would have been.
        const metaText = `\n${JSON.stringify(outcome.meta)}`;
        const last = content[content.length - 1];

        if (last?.type === "text") {
          content[content.length - 1] = { type: "text", text: last.text + metaText };
        } else {
          content.push({ type: "text", text: metaText });
        }
      }

      return {
        content,
        // A tool that sets no details declares `TDetails` as `undefined`, so the
        // field is always the one the tool promised; Pi's result type requires it
        // present rather than optional.
        details: outcome.details as TDetails,
        structuredContent: value,
      };
    },
  });
}
