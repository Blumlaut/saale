/**
 * Reading a stored `ChatMessage.stats` column back.
 *
 * Kept beside `turn-stats.ts` rather than in it: the conversation view imports
 * the calculators, and a zod schema in the same module would put zod in the
 * browser bundle.
 */

import { z } from "zod";
import type { TurnStats } from "./turn-stats";

/**
 * The parts of the context, including rows written before tool calls moved
 * into `tools` and the slice was called `toolResults`.
 */
const contextPartsSchema = z
  .object({
    systemPrompt: z.number(),
    tools: z.number().optional(),
    toolResults: z.number().optional(),
    userMessages: z.number(),
    responses: z.number(),
  })
  .transform(({ toolResults, tools, ...rest }) => ({
    ...rest,
    tools: tools ?? toolResults ?? 0,
  }));

/**
 * The column's shape. Annotated with the type the app reads, so the two cannot
 * drift apart without a compile error.
 */
export const turnStatsSchema: z.ZodType<TurnStats> = z.object({
  model: z.object({
    provider: z.string(),
    name: z.string(),
    /** The model the provider actually ran, when it differs (a router or an alias). */
    responseModel: z.string().nullish(),
  }),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  cost: z.number(),
  /** True when the provider reported the billed amount rather than a catalog estimate. */
  costFromProvider: z.boolean(),
  context: z.object({
    tokens: z.number().nullable(),
    window: z.number(),
    parts: contextPartsSchema,
  }),
});

/** Read a stored `ChatMessage.stats` column, or undefined when it holds something else. */
export function parseTurnStats(value: unknown): TurnStats | undefined {
  const parsed = turnStatsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
