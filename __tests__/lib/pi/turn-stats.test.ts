import { describe, it, expect } from "vitest";
import {
  TURN_STATS_PARTS,
  buildTurnStats,
  estimateContextParts,
  mergeTurnStats,
  parseTurnStats,
  scaleContextParts,
  type TranscriptMessageLike,
  type TurnStats,
} from "@/lib/pi/turn-stats";

/**
 * The card shows Pi's context total and a breakdown it has to measure itself,
 * so the invariant that matters is that the four parts always add up to the
 * total printed beside them, whatever the transcript looks like.
 */

/** A transcript row as Pi writes it, including the fields the breakdown ignores. */
function row(message: TranscriptMessageLike & Record<string, unknown>): TranscriptMessageLike {
  return message;
}

function stats(overrides: Partial<TurnStats> = {}): TurnStats {
  return {
    model: { provider: "anthropic", name: "claude-sonnet-4.5", responseModel: null },
    tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    cost: 0.5,
    costFromProvider: true,
    context: {
      tokens: 1000,
      window: 200000,
      parts: { systemPrompt: 100, tools: 400, userMessages: 100, responses: 400 },
    },
    ...overrides,
  };
}

describe("estimateContextParts", () => {
  it("splits the transcript by role, at roughly four characters per token", () => {
    const parts = estimateContextParts({
      systemPrompt: "s".repeat(400),
      messages: [
        { role: "user", content: [{ type: "text", text: "u".repeat(400) }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "a".repeat(400) },
            { type: "toolCall", arguments: { query: "x" } },
          ],
        },
        { role: "toolResult", content: [{ type: "text", text: "t".repeat(800) }] },
      ],
    });

    expect(parts.systemPrompt).toBe(100);
    expect(parts.userMessages).toBe(100);
    // 800 chars of tool result plus the serialized arguments of the call.
    expect(parts.tools).toBeGreaterThanOrEqual(200);
    expect(parts.tools).toBeLessThan(230);
    // The prose only: the arguments went to tools.
    expect(parts.responses).toBe(100);
  });

  it("counts an image at the allowance Pi makes for one", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
        { role: "toolResult", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
      ],
    });

    // A screenshot costs tokens with no text behind it; 4800 chars is Pi's own
    // allowance for one.
    expect(parts.userMessages).toBe(1200);
    expect(parts.tools).toBe(1200);
  });

  /**
   * Pi's blocks carry opaque signatures beside their text: Anthropic's thinking
   * signature, a provider's text signature. They are payloads rather than
   * words, and Pi's own estimator counts only the readable half.
   */
  it("counts a block's text, not the signature stored beside it", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "a".repeat(400), textSignature: "s".repeat(4000) },
            { type: "thinking", thinking: "h".repeat(200), thinkingSignature: "g".repeat(4000) },
          ],
        },
      ],
    });

    expect(parts.responses).toBe(100 + 50);
  });

  it("counts a tool call's name and arguments, the fields Pi's estimator counts", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "call-2", name: "bash", arguments: {} },
          ],
        },
      ],
    });

    // Two names, plus `{"command":"ls"}` and `{}`; the id is a reference, not prompt.
    expect(parts.tools).toBe(Math.round((2 * "bash".length + 16 + 2) / 4));
  });

  it("measures a tool result's text, not the bookkeeping beside it", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        row({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          details: { stdout: "d".repeat(4000) },
          nestedCalls: { calls: [{ id: "x", name: "y", status: "ok" }], complete: true },
          usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
          content: [{ type: "text", text: "t".repeat(400) }],
        }),
      ],
    });

    expect(parts.tools).toBe(100);
  });

  /** Pi's blocks are text, thinking, images and tool calls; anything else scores zero. */
  it("ignores a block it has no measure for", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        { role: "user", content: [{ type: "audio", data: "A".repeat(4000) }, "u".repeat(40)] },
      ],
    });

    expect(parts.userMessages).toBe(10);
  });

  /**
   * Pi's transcript holds rows that are not user or assistant turns. It sends
   * all four of these as user content, so they are prompt a provider bills; a
   * chat that was compacted carries a summary from then on.
   */
  it("counts the transcript rows Pi replays as user content", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        { role: "bashExecution", command: "ls", output: "o".repeat(400) },
        { role: "compactionSummary", summary: "s".repeat(400) },
        { role: "branchSummary", summary: "b".repeat(200) },
        { role: "custom", content: [{ type: "text", text: "c".repeat(400) }] },
        { role: "custom", content: "d".repeat(400) },
        { role: "user", content: "u".repeat(40) },
      ],
    });

    // A shell execution is tool traffic; the summaries and an extension's
    // message are replayed as what the user sent.
    expect(parts.tools).toBe(101);
    expect(parts.userMessages).toBe(100 + 50 + 100 + 100 + 10);
  });

  it("leaves out the shell execution Pi keeps out of the request", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        { role: "bashExecution", command: "ls", output: "o".repeat(400), excludeFromContext: true },
        { role: "bashExecution", command: "pwd", output: "p".repeat(400) },
      ],
    });

    expect(parts.tools).toBe(Math.round(("pwd".length + 400) / 4));
  });

  /**
   * Pi appends a system row whenever the prompt's sections or tools change mid
   * chat. The prompt is measured from `session.systemPrompt` already, so those
   * rows must not add a second copy of it.
   */
  it("does not count the transcript's system rows a second time", () => {
    const parts = estimateContextParts({
      systemPrompt: "s".repeat(400),
      messages: [
        row({
          role: "system",
          content: "s".repeat(400),
          sections: { rules: "r".repeat(400) },
          toolsAdded: [{ name: "bash", description: "Run a command" }],
        }),
        { role: "user", content: "u".repeat(40) },
      ],
    });

    expect(parts).toEqual({ systemPrompt: 100, tools: 0, userMessages: 10, responses: 0 });
  });

  it("survives an extension message with no content at all", () => {
    // Pi normalizes a missing content array for untyped extensions; the row can
    // reach the transcript empty.
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [row({ role: "custom", customType: "note", content: null, display: false })],
    });

    expect(parts).toEqual({ systemPrompt: 0, tools: 0, userMessages: 0, responses: 0 });
  });

  it("skips messages that carry no content", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      messages: [
        { role: "bashExecution", command: "", output: "" },
        { role: "user", content: "u".repeat(40) },
      ],
    });
    expect(parts.userMessages).toBe(10);
  });

  it("puts the declared tool schemas in the tools slice", () => {
    const parts = estimateContextParts({
      systemPrompt: "s".repeat(400),
      tools: [
        {
          name: "bash",
          description: "Run a shell command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      messages: [],
    });

    expect(parts.systemPrompt).toBe(100);
    expect(parts.tools).toBeGreaterThan(20);
  });

  it("counts a tool's guidelines and description, not the code behind it", () => {
    const tool = {
      name: "bash",
      description: "Run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      promptGuidelines: ["Use bash for file operations"],
      execute: () => "x".repeat(4000),
    };

    const parts = estimateContextParts({ systemPrompt: "", tools: [tool], messages: [] });

    const declared = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines,
    }).length;
    expect(parts.tools).toBe(Math.round(declared / 4));
  });

  it("measures a tool handed over as plain text", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      tools: ["t".repeat(400)],
      messages: [],
    });

    expect(parts.tools).toBe(100);
  });

  it("leaves a tool it cannot read at zero", () => {
    const parts = estimateContextParts({
      systemPrompt: "",
      tools: [null, 42, { name: "bash" }],
      messages: [],
    });

    // A definition with no schema is the tool's name alone.
    expect(parts.tools).toBe(Math.round(JSON.stringify({ name: "bash" }).length / 4));
  });

  /**
   * A coder chat declares a dozen tools, and their schemas are a fixed cost on
   * every request. Counting them apart from the prompt is what keeps the
   * prompt's slice from being inflated by them while the transcript is short.
   */
  it("holds the system prompt slice at its real size as the transcript grows", () => {
    const systemPrompt = "p".repeat(6400);
    const tools = [
      {
        name: "bash",
        description: "Run a shell command in the worktree",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ];
    const toolChars = JSON.stringify(tools[0]).length;
    const realPrompt = Math.round(systemPrompt.length / 4);

    const shown = [0, 3, 20].map((turns) => {
      const messages = Array.from({ length: turns }, () => [
        { role: "user", content: [{ type: "text", text: "x".repeat(400) }] },
        { role: "assistant", content: [{ type: "text", text: "y".repeat(4000) }] },
        { role: "toolResult", content: [{ type: "text", text: "z".repeat(8000) }] },
      ]).flat();
      const transcriptChars = messages.reduce(
        (sum, message) => sum + (message.content[0] as { text: string }).text.length,
        0,
      );
      const total = Math.round((systemPrompt.length + toolChars + transcriptChars) / 4);

      return buildTurnStats({
        message: {},
        systemPrompt,
        tools,
        messages,
        context: { tokens: total, contextWindow: 200_000 },
      }).context.parts.systemPrompt;
    });

    for (const tokens of shown) expect(tokens).toBe(realPrompt);
  });

  /**
   * The chat the report was about: it grows with screenshots in it, and each
   * one is a thousand tokens the text estimate cannot see. Stretching every
   * part onto Pi's total credited them to the system prompt, so the prompt read
   * larger with every screenshot even though its text never changed.
   */
  it("leaves the system prompt where it is while screenshots fill the chat", () => {
    const systemPrompt = "p".repeat(9360);
    const promptTokens = Math.round(systemPrompt.length / 4);
    const tools = [
      {
        name: "screenshot",
        description: "Take a screenshot of the page",
        parameters: { type: "object", properties: { url: { type: "string" } } },
      },
    ];
    const toolChars = JSON.stringify(tools[0]).length;

    const shown = [1, 4, 12].map((shots) => {
      const messages = [
        { role: "user", content: [{ type: "text", text: "u".repeat(200) }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "a".repeat(800) },
            { type: "toolCall", arguments: { url: "https://example.test" } },
          ],
        },
        {
          role: "toolResult",
          content: [
            { type: "text", text: "t".repeat(2000) },
            ...Array.from({ length: shots }, () => ({
              type: "image",
              data: "A".repeat(40),
              mimeType: "image/png",
            })),
          ],
        },
      ];
      // What the provider bills: the text and the declared schema, plus a
      // screenshot's own tokens.
      const total = Math.round((systemPrompt.length + toolChars) / 4) + 1200 * shots;

      return buildTurnStats({
        message: {},
        systemPrompt,
        tools,
        messages,
        context: { tokens: total, contextWindow: 200_000 },
      }).context;
    });

    for (const context of shown) {
      expect(context.parts.systemPrompt).toBe(promptTokens);
      const sum = TURN_STATS_PARTS.reduce((acc, key) => acc + context.parts[key], 0);
      expect(sum).toBe(context.tokens);
    }
  });
});

describe("scaleContextParts", () => {
  const sum = (parts: Record<string, number>) =>
    Object.values(parts).reduce((acc, n) => acc + n, 0);

  it("shares the total out over the transcript and keeps the sum exact", () => {
    const scaled = scaleContextParts(
      { systemPrompt: 1, tools: 2, userMessages: 3, responses: 4 },
      100,
    );
    expect(scaled.systemPrompt).toBe(1);
    expect(sum(scaled)).toBe(100);
  });

  /**
   * The prompt is the one part whose size is known: it is exactly the text the
   * session sends. A transcript that is larger than the estimate must not move
   * it, or a chat with a screenshot in it reads a prompt four times its size.
   */
  it("holds the system prompt at its measured size and gives the rest away", () => {
    const scaled = scaleContextParts(
      { systemPrompt: 2340, tools: 1000, userMessages: 100, responses: 400 },
      10_000,
    );

    expect(scaled.systemPrompt).toBe(2340);
    expect(sum(scaled)).toBe(10_000);
    // The three measured parts keep their proportions to each other.
    expect(scaled.tools).toBeGreaterThan(scaled.responses);
    expect(scaled.responses).toBeGreaterThan(scaled.userMessages);
  });

  it("puts the rounding drift on the largest part, so the sum still matches", () => {
    const scaled = scaleContextParts(
      { systemPrompt: 1, tools: 1, userMessages: 1, responses: 5 },
      10,
    );
    expect(TURN_STATS_PARTS.reduce((acc, key) => acc + scaled[key], 0)).toBe(10);
    expect(scaled.systemPrompt).toBe(1);
    // The responses are the largest part of the transcript, so they carry the odd token.
    expect(scaled.responses).toBe(7);
  });

  it("gives the whole remainder to the responses when nothing else was measured", () => {
    const scaled = scaleContextParts(
      { systemPrompt: 10, tools: 0, userMessages: 0, responses: 0 },
      100,
    );

    expect(scaled).toEqual({ systemPrompt: 10, tools: 0, userMessages: 0, responses: 90 });
  });

  it("scales everything down when the total is smaller than the prompt", () => {
    const scaled = scaleContextParts(
      { systemPrompt: 100, tools: 0, userMessages: 0, responses: 0 },
      50,
    );

    // The estimate cannot be split, but the card still adds up.
    expect(scaled.systemPrompt).toBe(50);
    expect(sum(scaled)).toBe(50);
  });

  it("leaves the estimates alone when the total is unknown or empty", () => {
    const raw = { systemPrompt: 11, tools: 22, userMessages: 33, responses: 44 };
    expect(scaleContextParts(raw, null)).toEqual(raw);
    expect(scaleContextParts(raw, 0)).toEqual(raw);
    expect(
      scaleContextParts({ systemPrompt: 0, tools: 0, userMessages: 0, responses: 0 }, 10),
    ).toEqual({ systemPrompt: 0, tools: 0, userMessages: 0, responses: 0 });
  });
});

describe("buildTurnStats", () => {
  it("reads usage, cost and the model off the assistant message", () => {
    const built = buildTurnStats({
      message: {
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.5",
        responseModel: "claude-sonnet-4.5-20260101",
        usage: {
          input: 1200,
          output: 300,
          cacheRead: 8000,
          cacheWrite: 100,
          cost: { total: 0.0421, totalFromProvider: true },
        },
      },
      systemPrompt: "s".repeat(400),
      messages: [{ role: "user", content: "u".repeat(400) }],
      context: { tokens: 9000, contextWindow: 200000 },
    });

    expect(built.model).toEqual({
      provider: "openrouter",
      name: "anthropic/claude-sonnet-4.5",
      responseModel: "claude-sonnet-4.5-20260101",
    });
    expect(built.tokens).toEqual({ input: 1200, output: 300, cacheRead: 8000, cacheWrite: 100 });
    expect(built.cost).toBeCloseTo(0.0421);
    expect(built.costFromProvider).toBe(true);
    expect(built.context.window).toBe(200000);
    const sum = TURN_STATS_PARTS.reduce((acc, key) => acc + built.context.parts[key], 0);
    expect(sum).toBe(9000);
  });

  it("keeps a provider that reports nothing at zero rather than guessing", () => {
    const built = buildTurnStats({
      message: { provider: "local", model: "qwen3" },
      systemPrompt: "",
      messages: [],
      context: { tokens: null, contextWindow: 32000 },
    });

    expect(built.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(built.cost).toBe(0);
    expect(built.costFromProvider).toBe(false);
    expect(built.context.tokens).toBeNull();
    expect(built.context.parts).toEqual({
      systemPrompt: 0,
      tools: 0,
      userMessages: 0,
      responses: 0,
    });
  });

  /**
   * Pi's usage carries more than the card shows: a total, reasoning tokens that
   * are already inside `output`, and Anthropic's 1h cache-write split. The row
   * keeps the four counters a provider reports, so they always add up.
   */
  it("keeps the four counters when the provider also reports a total", () => {
    const built = buildTurnStats({
      message: {
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        usage: {
          input: 1200,
          output: 300,
          cacheRead: 8000,
          cacheWrite: 100,
          cacheWrite1h: 40,
          reasoning: 120,
          totalTokens: 9600,
          cost: {
            input: 0.01,
            output: 0.02,
            cacheRead: 0.001,
            cacheWrite: 0.0002,
            total: 0.0312,
          },
        },
      },
      systemPrompt: "",
      messages: [],
      context: { tokens: 9600, contextWindow: 200_000 },
    });

    expect(built.tokens).toEqual({ input: 1200, output: 300, cacheRead: 8000, cacheWrite: 100 });
    expect(built.cost).toBeCloseTo(0.0312);
    expect(built.costFromProvider).toBe(false);
  });

  it("records a turn Pi cannot size without inventing a split", () => {
    // A failed or aborted turn leaves `getContextUsage` at null until the next
    // response arrives; the parts stay the measured ones.
    const built = buildTurnStats({
      message: { provider: "anthropic", model: "claude-sonnet-4.5", stopReason: "error" },
      systemPrompt: "s".repeat(400),
      messages: [{ role: "user", content: "u".repeat(400) }],
      context: { tokens: null, contextWindow: 200_000 },
    });

    expect(built.context.tokens).toBeNull();
    expect(built.context.parts).toEqual({
      systemPrompt: 100,
      tools: 0,
      userMessages: 100,
      responses: 0,
    });
  });

  it("leaves the response model empty when the provider ran the alias", () => {
    const built = buildTurnStats({
      message: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
      systemPrompt: "",
      messages: [],
      // A model that declares no window: Pi reports none either.
      context: { tokens: null, contextWindow: 0 },
    });

    expect(built.model).toEqual({
      provider: "openrouter",
      name: "anthropic/claude-sonnet-4.5",
      responseModel: null,
    });
    expect(built.context.window).toBe(0);
  });
});

describe("mergeTurnStats", () => {
  it("adds up a multi-turn answer and takes model and context from its last turn", () => {
    const merged = mergeTurnStats([
      stats({ tokens: { input: 10, output: 1, cacheRead: 100, cacheWrite: 0 }, cost: 0.1 }),
      stats({
        model: { provider: "openai", name: "gpt-6.1-sol", responseModel: null },
        tokens: { input: 20, output: 2, cacheRead: 200, cacheWrite: 5 },
        cost: 0.2,
        context: {
          tokens: 5000,
          window: 400000,
          parts: { systemPrompt: 1, tools: 2, userMessages: 3, responses: 4 },
        },
      }),
    ]);

    expect(merged?.tokens).toEqual({ input: 30, output: 3, cacheRead: 300, cacheWrite: 5 });
    expect(merged?.cost).toBeCloseTo(0.3);
    expect(merged?.model.name).toBe("gpt-6.1-sol");
    expect(merged?.context.tokens).toBe(5000);
  });

  it("calls the total estimated when any turn of the group was estimated", () => {
    expect(mergeTurnStats([stats(), stats({ costFromProvider: false })])?.costFromProvider).toBe(
      false,
    );
    expect(mergeTurnStats([stats(), stats()])?.costFromProvider).toBe(true);
  });

  it("has nothing to show when no turn recorded stats", () => {
    expect(mergeTurnStats([])).toBeUndefined();
    expect(mergeTurnStats([undefined, undefined])).toBeUndefined();
  });

  it("hands back a lone turn as it is", () => {
    const one = stats();
    expect(mergeTurnStats([undefined, one, undefined])).toEqual(one);
  });

  it("keeps the last turn's unknown context unknown", () => {
    // Compaction wipes the size Pi had; an older turn's number is stale.
    const merged = mergeTurnStats([
      stats(),
      stats({
        context: {
          tokens: null,
          window: 200_000,
          parts: { systemPrompt: 100, tools: 0, userMessages: 0, responses: 0 },
        },
      }),
    ]);

    expect(merged?.context.tokens).toBeNull();
  });
});

describe("parseTurnStats", () => {
  it("reads a stored column back", () => {
    expect(parseTurnStats(JSON.parse(JSON.stringify(stats())))).toEqual(stats());
  });

  it("reads a row written before the tool slice was renamed", () => {
    const legacy = JSON.parse(JSON.stringify(stats())) as Record<string, unknown>;
    const context = legacy.context as { parts: Record<string, number> };
    context.parts = { systemPrompt: 100, toolResults: 400, userMessages: 100, responses: 400 };

    expect(parseTurnStats(legacy)?.context.parts).toEqual({
      systemPrompt: 100,
      tools: 400,
      userMessages: 100,
      responses: 400,
    });
  });

  it("drops anything that is not a stats object", () => {
    expect(parseTurnStats(null)).toBeUndefined();
    expect(parseTurnStats({ model: { provider: "x" } })).toBeUndefined();
    expect(parseTurnStats("nonsense")).toBeUndefined();
  });

  it("prefers the renamed slice when a row carries both", () => {
    const both = JSON.parse(JSON.stringify(stats())) as Record<string, unknown>;
    const context = both.context as { parts: Record<string, number> };
    context.parts = {
      systemPrompt: 100,
      tools: 400,
      toolResults: 900,
      userMessages: 100,
      responses: 400,
    };

    expect(parseTurnStats(both)?.context.parts.tools).toBe(400);
  });

  it("reads a row whose slices predate tool counting", () => {
    const legacy = JSON.parse(JSON.stringify(stats())) as Record<string, unknown>;
    const context = legacy.context as { parts: Record<string, number> };
    context.parts = { systemPrompt: 100, userMessages: 100, responses: 400 };

    expect(parseTurnStats(legacy)?.context.parts.tools).toBe(0);
  });

  it("drops a row that lost a part", () => {
    const partial = JSON.parse(JSON.stringify(stats())) as Record<string, unknown>;
    delete (partial.context as { parts: Record<string, number> }).parts.userMessages;

    expect(parseTurnStats(partial)).toBeUndefined();
  });
});
