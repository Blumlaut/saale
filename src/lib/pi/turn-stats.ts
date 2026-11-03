import { z } from "zod";

/**
 * What one assistant turn cost, and where its context went.
 *
 * Pi reports the context total and the tokens a turn used; it does not say
 * which part of the transcript filled the window. The breakdown is therefore
 * measured from the prompt, the declared tools and the transcript, and scaled
 * onto Pi's total, so the number at the top stays Pi's while the proportions
 * are an estimate. The prompt keeps its measured size, the rest shares out what
 * is left.
 */

/** Roughly four characters per token, the same allowance Pi's own estimator makes. */
const CHARS_PER_TOKEN = 4;

/** Pi's own allowance for one image, which costs tokens with no text to measure. */
const IMAGE_CHARS = 4800;

/** The four things that fill a chat's context. */
export const TURN_STATS_PARTS = ["systemPrompt", "tools", "userMessages", "responses"] as const;

/** The parts beside the prompt, which share out whatever total is left. */
const TRANSCRIPT_PARTS = ["tools", "userMessages", "responses"] as const;

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

/**
 * The fields of a transcript message this file reads.
 *
 * Pi's transcript holds more than user and assistant rows. A shell execution,
 * an extension's message and the summary a compaction leaves behind are all
 * replayed to the model as user content.
 */
export interface TranscriptMessageLike {
  role: string;
  content?: unknown;
  /** The text of a `compactionSummary` or `branchSummary` row. */
  summary?: unknown;
  /** The command of a `bashExecution` row. */
  command?: unknown;
  /** Its output. */
  output?: unknown;
}

/** Characters one content block carries. */
function blockChars(block: unknown): number {
  if (typeof block === "string") return block.length;
  if (typeof block !== "object" || block === null) return 0;

  const record = block as Record<string, unknown>;
  if (record.type === "image") return IMAGE_CHARS;
  if (record.type === "text" && typeof record.text === "string") return record.text.length;
  if (record.type === "thinking" && typeof record.thinking === "string") {
    return record.thinking.length;
  }
  if (record.type === "toolCall" && record.arguments !== undefined) {
    return JSON.stringify(record.arguments).length;
  }
  return 0;
}

/** Characters a message's content blocks carry. */
function contentChars(content: unknown): number {
  const blocks: unknown[] = Array.isArray(content) ? content : [content];
  return blocks.reduce<number>((sum, block) => sum + blockChars(block), 0);
}

function textChars(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

/**
 * Characters a declared tool costs. Its schema travels beside the transcript,
 * so leaving it out credits its tokens to whichever part has text.
 */
function toolChars(tool: unknown): number {
  if (typeof tool === "string") return tool.length;
  if (typeof tool !== "object" || tool === null) return 0;

  const { name, description, parameters, promptGuidelines } = tool as Record<string, unknown>;
  return JSON.stringify({ name, description, parameters, promptGuidelines }).length;
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
 * The system prompt is Saale's own text (persona, rules), so it is the share a
 * user can actually shave. A call's arguments count as tools: a written file
 * body is tool traffic, and it is resent with every turn after it.
 */
export function estimateContextParts(input: {
  systemPrompt: string;
  /** The tool definitions sent beside the prompt, as `getToolDefinition` returns them. */
  tools?: ReadonlyArray<unknown> | undefined;
  messages: ReadonlyArray<TranscriptMessageLike>;
}): ContextParts {
  const chars: Record<TurnStatsPart, number> = {
    systemPrompt: input.systemPrompt.length,
    tools: 0,
    userMessages: 0,
    responses: 0,
  };

  for (const tool of input.tools ?? []) chars.tools += toolChars(tool);

  for (const message of input.messages) {
    switch (message.role) {
      case "assistant":
        for (const block of Array.isArray(message.content) ? message.content : [message.content]) {
          if (isToolCall(block)) chars.tools += blockChars(block);
          else chars.responses += blockChars(block);
        }
        break;
      case "toolResult":
        chars.tools += contentChars(message.content);
        break;
      // A shell execution rides in the prompt as a user message, and it is tool
      // traffic: the command and its output are what the tool returned.
      case "bashExecution":
        chars.tools += textChars(message.command) + textChars(message.output);
        break;
      case "compactionSummary":
      case "branchSummary":
        chars.userMessages += textChars(message.summary);
        break;
      case "custom":
        chars.userMessages += contentChars(message.content);
        break;
      case "user":
        chars.userMessages += contentChars(message.content);
        break;
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
 * reports.
 *
 * The system prompt is the one part whose size is known: it is exactly the text
 * the session sends. It keeps that size, and the other three share out what is
 * left, with the rounding drift on the largest so the four always sum to the
 * total shown beside them. Scaling every part by the same factor made the
 * prompt read larger with every turn, since a screenshot or a provider's own
 * tokenizer is a cost the estimate cannot see.
 */
export function scaleContextParts(parts: ContextParts, total: number | null): ContextParts {
  const sum = TURN_STATS_PARTS.reduce((acc, key) => acc + parts[key], 0);
  if (total === null || total <= 0 || sum <= 0) return parts;

  // A total below the prompt cannot be split, so scale everything and let the
  // card keep adding up.
  if (parts.systemPrompt >= total) {
    const scaled = {} as ContextParts;
    for (const key of TURN_STATS_PARTS) scaled[key] = Math.round((parts[key] / sum) * total);
    return applyDrift(scaled, total, TURN_STATS_PARTS);
  }

  const budget = total - parts.systemPrompt;
  const restSum = sum - parts.systemPrompt;
  const scaled: ContextParts = {
    systemPrompt: parts.systemPrompt,
    tools: 0,
    userMessages: 0,
    responses: 0,
  };
  for (const key of TRANSCRIPT_PARTS) {
    scaled[key] = restSum > 0 ? Math.round((parts[key] / restSum) * budget) : 0;
  }
  // An empty transcript still has a total to show.
  if (restSum <= 0) scaled.responses = budget;
  return applyDrift(scaled, total, TURN_STATS_PARTS);
}

/** Put the rounding drift on the largest of `keys`, so the parts sum to `total`. */
function applyDrift(
  parts: ContextParts,
  total: number,
  keys: readonly TurnStatsPart[],
): ContextParts {
  const drift = total - TURN_STATS_PARTS.reduce((acc, key) => acc + parts[key], 0);
  if (drift !== 0) {
    const largest = keys.reduce((best, key) => (parts[key] > parts[best] ? key : best));
    parts[largest] += drift;
  }
  return parts;
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
  /** The declared tools: the same list Pi sends on the request this turn answers. */
  tools?: ReadonlyArray<unknown> | undefined;
  messages: ReadonlyArray<TranscriptMessageLike>;
  context: { tokens: number | null; contextWindow: number };
}): TurnStats {
  const usage = input.message.usage;
  const estimated = estimateContextParts({
    systemPrompt: input.systemPrompt,
    tools: input.tools,
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
