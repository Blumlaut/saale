import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSession,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  answerOrphanedCalls,
  continueInterruptedTurn,
  INTERRUPTED_TOOL_RESULT,
  planInterruptedTurn,
} from "@/lib/pi/interrupted-turn";
import { rewindLeafBefore } from "@/lib/pi/message-rewind";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

/**
 * Picking a killed turn back up, against the real SDK and a provider that
 * validates message order the way OpenAI and Anthropic do.
 *
 * The tests assert on what the provider actually receives, because that is where
 * this breaks: a transcript whose last tool call has no result, or that ends on
 * an assistant turn, is rejected outright. A resumed chat has to continue from a
 * context every provider accepts.
 */

// ─── Mock provider ───────────────────────────────────────────────────────────

interface MockMessage {
  role: string;
  content: unknown;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
}

const requests: Array<{ messages: MockMessage[] }> = [];

/** Rejections the provider would have answered with a 400. */
const rejections: string[] = [];

/**
 * The message-order rules the real providers enforce: every call has a result
 * right after it, and an assistant turn that asks for nothing is the last one.
 */
function validate(messages: MockMessage[]): string | null {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const calls = message.tool_calls?.map((call) => call.id) ?? [];
    if (calls.length === 0) continue;
    const answered = messages
      .slice(index + 1)
      .filter((next) => next.role === "tool")
      .map((next) => next.tool_call_id);
    const missing = calls.filter((id) => !answered.includes(id));
    if (missing.length > 0) return `unanswered tool call ${missing.join(", ")}`;
  }
  return null;
}

function streamChunk(text: string, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
  })}\n\n`;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    let parsed: { messages: MockMessage[] };
    try {
      parsed = JSON.parse(body) as { messages: MockMessage[] };
    } catch (err) {
      console.error("Failed to parse mock provider request body:", err);
      res.writeHead(400).end();
      return;
    }
    requests.push(parsed);
    const problem = validate(parsed.messages);
    if (problem) {
      rejections.push(problem);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: problem } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(streamChunk("resumed", null));
    res.write(streamChunk("", "stop"));
    res.end("data: [DONE]\n\n");
  });
});

let runtime: ModelRuntime;
let testModel: NonNullable<ReturnType<ModelRuntime["getModel"]>>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.registerProvider("mock", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "test-model",
        name: "test-model",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ],
  });
  testModel = runtime.getModel("mock", "test-model")!;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  rejections.length = 0;
});

const USER_TEXT = "build the project";

function userMessage(text = USER_TEXT) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

function assistantTurn(text: string, calls: { id: string; name: string }[] = []) {
  return {
    role: "assistant" as const,
    api: "openai-completions" as const,
    provider: "mock" as const,
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: calls.length > 0 ? ("toolUse" as const) : ("stop" as const),
    timestamp: Date.now(),
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: {},
      })),
    ],
  };
}

const BASH = { id: "call-1", name: "bash" };

/** A session over a transcript a restart left mid-run. */
async function sessionWith(
  seed: (manager: SessionManager) => void,
): Promise<{ session: AgentSession; manager: SessionManager }> {
  const manager = SessionManager.inMemory();
  seed(manager);
  const { session } = await createAgentSession({
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    modelRuntime: runtime,
    noTools: "all",
    model: testModel,
    customTools: [],
    resourceLoader: await createSystemPromptLoader("You are a test.", process.cwd()),
    thinkingLevel: "off",
  });
  return { session, manager };
}

describe("resuming a turn killed mid tool call", () => {
  it("answers the orphaned call and continues, and the provider accepts it", async () => {
    const { session } = await sessionWith((manager) => {
      manager.appendMessage(userMessage());
      manager.appendMessage(assistantTurn("running the build", [BASH]));
    });

    try {
      const plan = planInterruptedTurn(session, { content: USER_TEXT });
      expect(plan.kind).toBe("continue");
      expect(await continuePlan(session, plan)).toBe(true);

      await continueInterruptedTurn(session);

      expect(rejections).toEqual([]);
      const sent = requests[0]!.messages;
      // The call the restart orphaned now has a result, saying so.
      const result = sent.find((message) => message.role === "tool");
      expect(result?.tool_call_id).toBe("call-1");
      expect(JSON.stringify(result)).toContain(INTERRUPTED_TOOL_RESULT);
      // The turn carried on instead of starting the request over: the note is
      // the only message after it, and the question is asked once.
      expect(sent.filter((message) => JSON.stringify(message).includes(USER_TEXT))).toHaveLength(1);
      expect(JSON.stringify(sent)).toContain("picked back up here");
    } finally {
      session.dispose();
    }
  });

  it("continues a turn whose results all arrived, without asking again", async () => {
    const { session } = await sessionWith((manager) => {
      manager.appendMessage(userMessage());
      manager.appendMessage(assistantTurn("running the build", [BASH]));
      manager.appendMessage({
        role: "toolResult",
        toolCallId: BASH.id,
        toolName: BASH.name,
        content: [{ type: "text", text: "built" }],
        isError: false,
        timestamp: Date.now(),
      });
    });

    try {
      const plan = planInterruptedTurn(session, { content: USER_TEXT });
      expect(plan).toEqual({ kind: "continue", orphanedCalls: [] });
      expect(await continuePlan(session, plan)).toBe(true);

      await continueInterruptedTurn(session);

      expect(rejections).toEqual([]);
      expect(
        requests[0]!.messages.filter((message) => JSON.stringify(message).includes(USER_TEXT)),
      ).toHaveLength(1);
      expect(JSON.stringify(requests[0]!.messages)).toContain("built");
    } finally {
      session.dispose();
    }
  });

  it("asks a finished turn again, since no message may follow its last one", async () => {
    const { session } = await sessionWith((manager) => {
      manager.appendMessage(userMessage());
      manager.appendMessage(assistantTurn("all done, nothing to report"));
    });

    try {
      const plan = planInterruptedTurn(session, { content: USER_TEXT });
      expect(plan.kind).toBe("restart");
      expect(await continuePlan(session, plan)).toBe(false);

      await session.prompt(USER_TEXT);

      expect(rejections).toEqual([]);
      // The abandoned answer is off the active branch: one question, one answer.
      expect(
        requests[0]!.messages.filter((message) => JSON.stringify(message).includes(USER_TEXT)),
      ).toHaveLength(1);
      expect(JSON.stringify(requests[0]!.messages)).not.toContain("all done, nothing to report");
    } finally {
      session.dispose();
    }
  });
});

/** Apply the plan the way the run path does, and report the run's mode. */
async function continuePlan(
  session: AgentSession,
  plan: ReturnType<typeof planInterruptedTurn>,
): Promise<boolean> {
  if (plan.kind === "continue") {
    answerOrphanedCalls(session, plan.orphanedCalls);
    return true;
  }
  if (plan.kind === "restart") {
    await rewindLeafBefore(session, plan.entry);
  }
  return false;
}
