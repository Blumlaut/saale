import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";

/**
 * Integration tests for provider failures, retries and aborts.
 *
 * The unit tests for the session event tracker encode the SDK's event semantics
 * as assumptions (which events fire, and what `willRetry` means). These replace
 * those assumptions with the real SDK: a real agent session runs against a local
 * mock provider, the real tracker persists through a fake database, and the
 * surviving rows are asserted.
 *
 * Retry backoff is dialled down to a millisecond through the SDK's settings
 * manager, so the retry paths stay fast enough for CI.
 */

// ─── Fake database ───────────────────────────────────────────────────────────

interface Row {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: string | null;
  errorMessage: string | null;
  parentMessageId: string | null;
}

const store = vi.hoisted(() => {
  const rows = new Map<string, Record<string, unknown>>();
  let seq = 0;
  return {
    rows,
    nextId: () => `msg-${++seq}`,
    reset: () => {
      rows.clear();
      seq = 0;
    },
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    chatMessage: {
      create: async (args: { data: Record<string, unknown> }) => {
        const id = store.nextId();
        store.rows.set(id, { id, ...args.data });
        return { id };
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = store.rows.get(args.where.id);
        if (!existing) throw new Error(`row ${args.where.id} not found`);
        store.rows.set(args.where.id, { ...existing, ...args.data });
        return { id: args.where.id };
      },
      deleteMany: async (args: { where: { id?: string; sessionId?: string } }) => {
        const { id, sessionId } = args.where;
        let count = 0;
        for (const [rowId, row] of store.rows) {
          const idMatches = id === undefined || rowId === id;
          const sessionMatches = sessionId === undefined || row.sessionId === sessionId;
          if (idMatches && sessionMatches && store.rows.delete(rowId)) count++;
        }
        return { count };
      },
    },
    chatSession: { update: async () => ({}) },
  },
}));

vi.mock("@/lib/redis", () => ({
  registerActiveSession: async () => {},
  unregisterActiveSession: async () => {},
}));

vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: async () => {},
  resetSessionEvents: async () => {},
}));

vi.mock("@/lib/chat/compaction", () => ({
  saveCompactionMessage: async () => {},
}));

import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createSessionEventTracker } from "@/lib/pi/session-event-tracker";
import { lockSystemPrompt } from "@/lib/pi/processing-state";
import { requestSessionAbort } from "@/lib/pi/abort-request";
import { withAbortSignal } from "@/lib/pi/tool-abort";

// ─── Mock provider ───────────────────────────────────────────────────────────

type Reply =
  /** JSON error response (a provider rejection). */
  | { kind: "error"; status: number; body: unknown }
  /** A complete SSE answer. */
  | { kind: "answer"; text: string }
  /** An SSE stream that emits one chunk and never finishes. */
  | { kind: "hang"; text: string }
  /** A complete answer that asks for one tool call. */
  | { kind: "toolCall"; name: string };

const PORT = 36_913;
const HANGING_TEXT = "Starting to answer";

let nextReply: () => Reply = () => ({ kind: "error", status: 500, body: {} });
let requests = 0;

function streamChunk(text: string, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: finish }],
  })}\n\n`;
}

/** Responses left open by a hanging reply; destroyed when the suite ends. */
const openResponses = new Set<http.ServerResponse>();

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    requests++;
    const reply = nextReply();

    if (reply.kind === "error") {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    if (reply.kind === "toolCall") {
      res.write(
        `data: ${JSON.stringify({
          id: "1",
          object: "chat.completion.chunk",
          created: 1,
          model: "test-model",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: reply.name, arguments: "{}" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      res.write(streamChunk("", "tool_calls"));
      res.end("data: [DONE]\n\n");
      return;
    }

    res.write(streamChunk(reply.text, null));

    if (reply.kind === "hang") {
      // Deliberately never completes: only the client's abort ends it. (Do not
      // hook req's "close" — that fires as soon as the request body is read.)
      openResponses.add(res);
      res.on("close", () => openResponses.delete(res));
      return;
    }

    res.write(streamChunk("", "stop"));
    res.end("data: [DONE]\n\n");
  });
});

// ─── Harness ─────────────────────────────────────────────────────────────────

let runtime: ModelRuntime;
let TEST_MODEL: NonNullable<ReturnType<ModelRuntime["getModel"]>>;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.registerProvider("mock", {
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
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
  TEST_MODEL = runtime.getModel("mock", "test-model")!;
});

afterAll(async () => {
  for (const res of openResponses) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  store.reset();
  requests = 0;
});

/**
 * Run one real session through the real tracker and return the rows it left.
 *
 * @param maxRetries - SDK retry budget (backoff is a millisecond).
 * @param abortAfterMs - abort the run after this delay, as the Stop route does.
 * @param userAbort - whether the abort is recorded as a user-initiated stop.
 */
async function runSession(options: {
  maxRetries?: number;
  abortAfterMs?: number;
  userAbort?: boolean;
  tools?: NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"];
}): Promise<{ rows: Row[]; requests: number }> {
  const sessionId = "session-int";
  const settings = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: options.maxRetries ?? 0, baseDelayMs: 1 },
  });

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    settingsManager: settings,
    modelRuntime: runtime,
    noTools: "builtin",
    model: TEST_MODEL,
    customTools: options.tools ?? [],
    thinkingLevel: "off",
  });
  lockSystemPrompt(session, "You are a test.");

  const settled = new Promise<void>((resolve, reject) => {
    createSessionEventTracker({
      sessionId,
      userId: "user-int",
      session,
      onDone: resolve,
    });
    session.prompt("hello").catch(reject);

    if (options.abortAfterMs !== undefined) {
      setTimeout(() => {
        if (options.userAbort) requestSessionAbort("user-int", sessionId);
        void session.abort();
      }, options.abortAfterMs);
    }
  });

  let guard: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error("session did not settle")), 15_000);
  });

  try {
    await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(guard);
    session.dispose();
  }

  return { rows: [...store.rows.values()] as unknown as Row[], requests };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("provider failures (real SDK)", () => {
  it("persists the error for a non-retryable failure", async () => {
    nextReply = () => ({
      kind: "error",
      status: 400,
      body: { error: { message: "Invalid max_tokens value", type: "invalid_request_error" } },
    });

    const { rows, requests: attempts } = await runSession({ maxRetries: 0 });

    expect(attempts).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      content: "",
      errorMessage: '400: {"message":"Invalid max_tokens value","type":"invalid_request_error"}',
    });
  });

  it("leaves one row, not one per attempt, when retries are exhausted", async () => {
    nextReply = () => ({
      kind: "error",
      status: 503,
      body: { error: { message: "Service unavailable" } },
    });

    const { rows, requests: attempts } = await runSession({ maxRetries: 2 });

    // Three attempts were made...
    expect(attempts).toBe(3);
    // ...but only the terminal one is left behind (previously: four rows).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      content: "",
      errorMessage: '503: {"message":"Service unavailable"}',
    });
  });

  it("keeps only the successful answer when a retry recovers", async () => {
    let attempt = 0;
    nextReply = () => {
      attempt++;
      return attempt <= 2
        ? { kind: "error", status: 503, body: { error: { message: "Service unavailable" } } }
        : { kind: "answer", text: "Recovered after retrying" };
    };

    const { rows, requests: attempts } = await runSession({ maxRetries: 3 });

    expect(attempts).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      content: "Recovered after retrying",
      errorMessage: null,
    });
  });

  it("keeps the partial answer and reports no error when the user stops", async () => {
    nextReply = () => ({ kind: "hang", text: HANGING_TEXT });

    const { rows } = await runSession({ maxRetries: 0, abortAfterMs: 250, userAbort: true });

    // A cancelled request is reported by Pi as stopReason "error" ("terminated").
    // Without the stop record this would surface as a provider error notice.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "assistant",
      content: HANGING_TEXT,
      errorMessage: null,
    });
  });

  it("reports no error for a plain mid-stream abort either", async () => {
    nextReply = () => ({ kind: "hang", text: HANGING_TEXT });

    // Aborting while the model streams leaves stopReason "aborted", which is not
    // a provider failure — no stop record is needed for this case.
    const { rows } = await runSession({ maxRetries: 0, abortAfterMs: 250 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(HANGING_TEXT);
    expect(rows[0]!.errorMessage).toBeNull();
  });
});

describe("stopping during a tool call (real SDK)", () => {
  it("ends the run immediately instead of waiting for the tool", async () => {
    // A tool that ignores the abort signal, as every Saale tool did: Pi awaits
    // it, so the run used to stay alive for the tool's full duration and Stop
    // looked like it did nothing.
    let toolFinished = false;
    const slowTool = {
      name: "slow_tool",
      label: "slow_tool",
      description: "Takes a while and ignores cancellation.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        toolFinished = true;
        return { content: [{ type: "text", text: "tool finished" }], details: {} };
      },
    } as unknown as NonNullable<
      NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"]
    >[number];

    // The provider asks for the tool, then keeps streaming.
    let phase = 0;
    nextReply = () => {
      phase++;
      return phase === 1
        ? { kind: "toolCall", name: "slow_tool" }
        : { kind: "hang", text: "still going" };
    };

    const startedAt = performance.now();
    const { rows } = await runSession({
      maxRetries: 0,
      abortAfterMs: 400,
      userAbort: true,
      tools: [withAbortSignal(slowTool)],
    });
    const elapsed = performance.now() - startedAt;

    // The run did not wait for the 3s tool.
    expect(elapsed).toBeLessThan(2000);
    expect(toolFinished).toBe(false);

    // The cancelled tool call is recorded as aborted, and the user's Stop is not
    // reported as a provider failure.
    const toolCallRow = rows.find((row) => row.toolCalls !== null);
    expect(toolCallRow?.toolCalls).toContain("Operation aborted");
    for (const row of rows) {
      expect(row.errorMessage).toBeNull();
    }
  });

  it("reports the tool-phase cancellation as an error without a stop record", async () => {
    const slowTool = {
      name: "slow_tool",
      label: "slow_tool",
      description: "Takes a while and ignores cancellation.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return { content: [{ type: "text", text: "tool finished" }], details: {} };
      },
    } as unknown as NonNullable<
      NonNullable<Parameters<typeof createAgentSession>[0]>["customTools"]
    >[number];

    let phase = 0;
    nextReply = () => {
      phase++;
      return phase === 1
        ? { kind: "toolCall", name: "slow_tool" }
        : { kind: "hang", text: "still going" };
    };

    // Aborting during a tool call (not while streaming) leaves an error-classified
    // message, so the record is what keeps a user's Stop out of the error report.
    const { rows } = await runSession({
      maxRetries: 0,
      abortAfterMs: 400,
      userAbort: false,
      tools: [withAbortSignal(slowTool)],
    });

    expect(rows.some((row) => row.errorMessage === "This operation was aborted")).toBe(true);
  });
});
