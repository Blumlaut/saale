import { beforeAll, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";
import { readContextUsage } from "@/lib/pi/context-usage";
import { TURN_STATS_PARTS, buildTurnStats, type TurnStats } from "@/lib/pi/turn-stats";

vi.mock("@/lib/db", () => ({
  prisma: { adminSettings: { findUnique: vi.fn().mockResolvedValue(null) } },
}));

/**
 * The breakdown has to hold against the transcript Pi actually builds, not just
 * the one the unit test describes. The prompt is fixed text, so its slice must
 * read the same on the first turn and on a later one whose tool results carry
 * screenshots.
 */

const PROMPT = "You are a test assistant.\n\n" + "rule line\n".repeat(120);

let runtime: ModelRuntime;
let model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
let faux: ReturnType<typeof fauxProvider>;

beforeAll(async () => {
  faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 4096 }] });
  runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const resolved = runtime.getModel(faux.provider.id, "faux-1");
  if (!resolved) throw new Error("the faux provider did not land in the runtime");
  model = resolved;
});

const screenshotTool: ToolDefinition = {
  name: "screenshot",
  description: "Take a screenshot of a page. " + "It returns a png. ".repeat(10),
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  execute: async () => ({
    content: [
      { type: "text", text: "see below" },
      { type: "image", data: "A".repeat(4000), mimeType: "image/png" },
    ],
  }),
} as unknown as ToolDefinition;

describe("the breakdown of a real session", () => {
  it("keeps the prompt slice put while screenshots pile up", async () => {
    faux.setResponses(
      Array.from({ length: 6 }, (_, turn) => [
        fauxAssistantMessage([fauxToolCall("screenshot", { url: `https://example.test/${turn}` })]),
        fauxAssistantMessage("done " + "x".repeat(400)),
      ]).flat(),
    );

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
      modelRuntime: runtime,
      model,
      noTools: "builtin",
      customTools: [screenshotTool],
      resourceLoader: await createSystemPromptLoader(PROMPT, process.cwd()),
      thinkingLevel: "off",
    });

    const seen: TurnStats[] = [];
    // Pi renders the prompt beside the cwd it was given; that is the text a
    // provider bills, and the text the breakdown has to hold.
    const promptTokens = Math.round(session.systemPrompt.length / 4);
    try {
      for (let turn = 0; turn < 3; turn += 1) {
        await session.prompt(`look at page ${turn}`);
        seen.push(
          buildTurnStats({
            message: {},
            systemPrompt: session.systemPrompt,
            tools: session.getActiveToolNames().flatMap((n) => session.getToolDefinition(n) ?? []),
            messages: session.messages,
            context: readContextUsage(session),
          }),
        );
      }
    } finally {
      session.dispose();
    }

    const [first, , last] = seen as [TurnStats, TurnStats, TurnStats];
    expect(first.context.parts.systemPrompt).toBe(promptTokens);
    expect(last.context.parts.systemPrompt).toBe(first.context.parts.systemPrompt);
    // The context itself grows with each screenshot, and the parts still add up.
    expect(last.context.tokens!).toBeGreaterThan(first.context.tokens!);
    for (const stats of seen) {
      const sum = TURN_STATS_PARTS.reduce((acc, key) => acc + stats.context.parts[key], 0);
      expect(sum).toBe(stats.context.tokens);
    }
  });
});
