import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

vi.mock("@/lib/db", () => ({
  prisma: { adminSettings: { findUnique: vi.fn().mockResolvedValue(null) } },
}));

/**
 * What a prompt cache needs from a live session: every follow-up request must
 * repeat the previous one byte for byte and only append to it. A provider
 * caches on that prefix, so a prompt that is stable when built twice is only
 * half the story; the session has to send it unchanged too.
 *
 * Only the model is faked. Pi builds each request from its own transcript, so
 * the captured contexts are exactly what the provider would have received.
 */

const PROMPT = "You are a test assistant. Follow these rules.";

let runtime: ModelRuntime;
let model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
let faux: ReturnType<typeof fauxProvider>;

beforeAll(async () => {
  faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 4096 }] });
  runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);

  const resolved = runtime.getModel(faux.provider.id, "faux-1");
  if (!resolved) throw new Error("The faux provider did not land in the runtime");
  model = resolved;
});

/** Run two prompts on a fresh session and hand back what the provider was sent. */
async function twoTurns(): Promise<TranscriptContext[]> {
  const contexts: TranscriptContext[] = [];
  faux.setResponses([
    (context) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("the first answer");
    },
    (context) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("the second answer");
    },
  ]);

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    modelRuntime: runtime,
    model,
    noTools: "builtin",
    customTools: [],
    resourceLoader: await createSystemPromptLoader(PROMPT, process.cwd()),
    thinkingLevel: "off",
  });

  try {
    await session.prompt("first question");
    await session.prompt("second question");
  } finally {
    session.dispose();
  }

  return contexts;
}

describe("the request a follow-up turn sends", () => {
  it("repeats the previous request and only appends to it", async () => {
    const contexts = await twoTurns();
    expect(contexts).toHaveLength(2);
    const [first, second] = contexts as [TranscriptContext, TranscriptContext];

    // The new turn carries the earlier transcript unchanged, which is what a
    // provider caches on. Anything rewritten here is a cache miss.
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);

    // The system prompt is the head of that prefix, so it must match exactly.
    expect(second.messages[0]).toEqual(first.messages[0]);

    // Exactly one user turn and one assistant reply were added.
    expect(second.messages).toHaveLength(first.messages.length + 2);
    expect(second.messages.at(-2)?.role).toBe("assistant");
    expect(second.messages.at(-1)?.role).toBe("user");
  });

  it("sends the prompt the loader was given, in its first message", async () => {
    const [first] = await twoTurns();
    expect(JSON.stringify(first!.messages[0])).toContain(PROMPT);
  });
});
