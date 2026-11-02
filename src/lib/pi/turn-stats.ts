import { z } from "zod";

/**
 * What one assistant turn cost, and where its context went.
 *
 * Pi reports the context total and the tokens a turn used; it does not say
 * which part of the transcript filled the window. The breakdown is therefore
 * measured from the transcript's own text and scaled onto Pi's total, so the
 * number at the top stays Pi's while the proportions are an estimate.
 */

/** Roughly four characters per token, the same fallback Pi uses for providers that report no usage. */
const CHARS_PER_TOKEN = 4;

/** The four things that fill a chat's context. */
export const TURN_STATS_PARTS = ["systemPrompt", "tools", "userMessages", "responses"] as const;

export type TurnStatsPart = (typeof TURN_STATS_PARTS)[number];

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

export const turnStatsSchema = z.object({
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

export type TurnStats = z.infer<typeof turnStatsSchema>;

/** Token counts per part, before or after scaling onto Pi's total. */
export type ContextParts = TurnStats["context"]["parts"];

/** Read a stored `ChatMessage.stats` column, or undefined when it holds something else. */
export function parseTurnStats(value: unknown): TurnStats | undefined {
  const parsed = turnStatsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Characters one content block carries, ignoring images (they cost tokens without text to measure). */
function blockChars(block: unknown): number {
  if (typeof block === "string") return block.length;
  if (typeof block !== "object" || block === null) return 0;

  const record = block as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text.length;
  if (record.type === "thinking" && typeof record.thinking === "string") {
    return record.thinking.length;
  }
  if (record.type === "toolCall" && record.arguments !== undefined) {
    return JSON.stringify(record.arguments).length;
  }
  return 0;
}

function isToolCall(block: unknown): boolean {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as Record<string, unknown>).type === "toolCall"
  );
}

/**
 * Estimate how the transcript splits between the four parts.
 *
 * The system prompt is Saale's own text (persona, rules, tool catalog), so it
 * is the share a user can actually shave. A call's arguments count as tools:
 * a written file body is tool traffic, and it is resent with every turn after
 * it.
 */
export function estimateContextParts(input: {
  systemPrompt: string;
  messages: ReadonlyArray<{ role: string; content?: unknown }>;
}): ContextParts {
  const chars: Record<TurnStatsPart, number> = {
    systemPrompt: input.systemPrompt.length,
    tools: 0,
    userMessages: 0,
    responses: 0,
  };

  for (const message of input.messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of blocks) {
      if (message.role === "toolResult") chars.tools += blockChars(block);
      else if (message.role === "user") chars.userMessages += blockChars(block);
      else if (message.role === "assistant") {
        if (isToolCall(block)) chars.tools += blockChars(block);
        else chars.responses += blockChars(block);
      }
    }
  }

  return {
    systemPrompt: Math.round(chars.systemPrompt / CHARS_PER_TOKEN),
    tools: Math.round(chars.tools / CHARS_PER_TOKEN),
    userMessages: Math.round(chars.userMessages / CHARS_PER_TOKEN),
    responses: Math.round(chars.responses / CHARS_PER_TOKEN),
  };
}

/**
 * Stretch or shrink the estimates so they add up to the context total Pi
 * reports. The shortfall goes on the largest part, so the four numbers always
 * sum to the total shown beside them.
 */
export function scaleContextParts(parts: ContextParts, total: number | null): ContextParts {
  const sum = TURN_STATS_PARTS.reduce((acc, key) => acc + parts[key], 0);
  if (total === null || total <= 0 || sum <= 0) return parts;

  const scaled = {} as ContextParts;
  for (const key of TURN_STATS_PARTS) {
    scaled[key] = Math.round((parts[key] / sum) * total);
  }

  const drift = total - TURN_STATS_PARTS.reduce((acc, key) => acc + scaled[key], 0);
  if (drift !== 0) {
    const largest = TURN_STATS_PARTS.reduce((best, key) =>
      scaled[key] > scaled[best] ? key : best,
    );
    scaled[largest] += drift;
  }
  return scaled;
}

/** The fields of an assistant message this file reads. */
interface AssistantMessageLike {
  provider?: string;
  model?: string;
  responseModel?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number; totalFromProvider?: boolean };
  };
}

/**
 * Assemble one turn's stats from the assistant message Pi hands back.
 *
 * Everything is read defensively: providers that report no usage leave the
 * token counts at zero, and a turn that produced nothing still gets a row with
 * the model that ran.
 */
export function buildTurnStats(input: {
  message: AssistantMessageLike;
  systemPrompt: string;
  messages: ReadonlyArray<{ role: string; content?: unknown }>;
  context: { tokens: number | null; contextWindow: number };
}): TurnStats {
  const usage = input.message.usage;
  const estimated = estimateContextParts({
    systemPrompt: input.systemPrompt,
    messages: input.messages,
  });

  return {
    model: {
      provider: input.message.provider ?? "",
      name: input.message.model ?? "",
      responseModel: input.message.responseModel ?? null,
    },
    tokens: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
    },
    cost: usage?.cost?.total ?? 0,
    costFromProvider: usage?.cost?.totalFromProvider === true,
    context: {
      tokens: input.context.tokens,
      window: input.context.contextWindow,
      parts: scaleContextParts(estimated, input.context.tokens),
    },
  };
}

/**
 * One card for a group of turns.
 *
 * A response is often several turns (a tool round trip each), and the card
 * speaks for the whole answer: costs and tokens add up, while model and
 * context come from the last turn, which is the state the next request starts
 * from.
 */
export function mergeTurnStats(turns: ReadonlyArray<TurnStats | undefined>): TurnStats | undefined {
  const present = turns.filter((turn): turn is TurnStats => turn !== undefined);
  const last = present[present.length - 1];
  if (!last) return undefined;

  return {
    model: last.model,
    tokens: {
      input: present.reduce((sum, turn) => sum + turn.tokens.input, 0),
      output: present.reduce((sum, turn) => sum + turn.tokens.output, 0),
      cacheRead: present.reduce((sum, turn) => sum + turn.tokens.cacheRead, 0),
      cacheWrite: present.reduce((sum, turn) => sum + turn.tokens.cacheWrite, 0),
    },
    cost: present.reduce((sum, turn) => sum + turn.cost, 0),
    // Only billed when every turn was: a mix of billed and estimated is an estimate.
    costFromProvider: present.every((turn) => turn.costFromProvider),
    context: last.context,
  };
}
