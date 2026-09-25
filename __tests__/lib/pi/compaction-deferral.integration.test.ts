import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { submitDeferringToCompaction } from "@/lib/pi/compaction-defer";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

/**
 * Prompting while a manual compaction is in progress (real SDK).
 *
 * Manual `/compact` runs in its own request, so a message that arrives while
 * it works always races it. Pi refuses such a prompt outright — "Cannot submit
 * a prompt while compaction is in progress" — which is what used to break the
 * chat: the run never started, nothing was answered, and the SSE connection
 * was torn down around the error.
 *
 * The mock provider holds the summarization call open, so the compaction is
 * kept in progress for as long as the test needs it, and the SDK's behaviour
 * and the deferral that works around it are asserted against the real thing.
 */

// ─── Mock provider ───────────────────────────────────────────────────────────

type Reply =
  /** A complete SSE answer. */
  | { kind: "answer"; text: string }
  /** Stream a chunk, then stay open until the test releases it. */
  | { kind: "hold"; text: string };

/** Replies, consumed in request order; the last one repeats. */
let script: Reply[] = [{ kind: "answer", text: "ok" }];
/** Handles for held responses, so a test can let them finish. */
const held: Array<() => void> = [];
/** Resolvers waiting for a hold to start. */
let holdWaiters: Array<() => void> = [];
/** Parsed request bodies, in order. */
let requestBodies: Array<Record<string, unknown>> = [];

function scriptReplies(...replies: Reply[]): void {
  script = replies;
}

function nextReply(): Reply {
  return script.length > 1 ? script.shift()! : script[0]!;
}

/** Resolves once a held reply is streaming (immediately if one already is). */
function waitForHold(): Promise<void> {
  if (held.length > 0) return Promise.resolve();
  return new Promise((resolve) => holdWaiters.push(resolve));
}

/** Let every held response finish. */
function releaseHeld(): void {
  for (const finish of held.splice(0)) finish();
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

/** Responses left open by a held reply; destroyed when the suite ends. */
const openResponses = new Set<http.ServerResponse>();

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: string) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      requestBodies.push(JSON.parse(body));
    } catch (err) {
      console.error("Failed to parse mock provider request body:", err);
    }

    const reply = nextReply();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(streamChunk(reply.text, null));

    if (reply.kind === "hold") {
      held.push(() => {
        res.write(streamChunk("", "stop"));
        res.end("data: [DONE]\n\n");
      });
      openResponses.add(res);
      res.on("close", () => openResponses.delete(res));
      for (const waiter of holdWaiters.splice(0)) waiter();
      return;
    }

    res.write(streamChunk("", "stop"));
    res.end("data: [DONE]\n\n");
  });
});

// ─── Harness ────────────────────────────────────────────────────────────────

let runtime: ModelRuntime;
let TEST_MODEL: NonNullable<ReturnType<ModelRuntime["getModel"]>>;

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
  TEST_MODEL = runtime.getModel("mock", "test-model")!;
});

afterAll(async () => {
  for (const res of openResponses) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  releaseHeld();
  script = [{ kind: "answer", text: "ok" }];
  holdWaiters = [];
  requestBodies = [];
});

async function createCompactionSession() {
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    // A tiny recent-token budget, so even a one-turn conversation has
    // something to compact — no need to build up real history.
    settingsManager: SettingsManager.inMemory({
      compaction: { keepRecentTokens: 1, reserveTokens: 1 },
    }),
    modelRuntime: runtime,
    noTools: "builtin",
    model: TEST_MODEL,
    customTools: [],
    resourceLoader: await createSystemPromptLoader("You are a test.", process.cwd()),
    thinkingLevel: "off",
  });
  return session;
}

/**
 * Open a conversation, then start a manual compaction whose summarization call
 * is held open (so the compaction stays in progress until the test releases
 * it).
 */
async function beginHeldCompaction() {
  const session = await createCompactionSession();

  scriptReplies({ kind: "answer", text: "first answer" });
  await session.prompt("first question");

  scriptReplies({ kind: "hold", text: "summary text" });
  const compaction = session.compact();
  await waitForHold();

  return { session, compaction };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("manual compaction vs. an incoming prompt (real SDK)", () => {
  it("Pi rejects a prompt submitted while the compaction is running", async () => {
    const { session, compaction } = await beginHeldCompaction();
    try {
      await expect(session.prompt("sent during compaction")).rejects.toThrow(
        /compaction is in progress/,
      );
    } finally {
      releaseHeld();
      await compaction;
      session.dispose();
    }
  });

  it("delivers a prompt sent during a compaction once it finishes", async () => {
    const { session, compaction } = await beginHeldCompaction();
    try {
      scriptReplies({ kind: "answer", text: "deferred answer" });

      const deferred = submitDeferringToCompaction(session, () =>
        session.prompt("sent during compaction"),
      );

      // Give the deferral time to attempt the prompt: it has to be waiting, not
      // submitting into a compacting session.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(session.isCompacting).toBe(true);
      expect(requestBodies).toHaveLength(2);

      releaseHeld();
      await deferred;

      const result = await compaction;
      expect(result.summary).toContain("summary text");

      // The prompt was submitted after the summarization call, so the model saw
      // the compacted conversation — and it was answered.
      expect(requestBodies).toHaveLength(3);
      expect(JSON.stringify(requestBodies[2])).toContain("sent during compaction");

      const roles = session.messages.map((m) => m.role);
      expect(roles[roles.length - 1]).toBe("assistant");
      expect(JSON.stringify(session.messages[session.messages.length - 1])).toContain(
        "deferred answer",
      );
      expect(roles).toContain("compactionSummary");
      expect(roles.indexOf("compactionSummary")).toBeLessThan(roles.lastIndexOf("user"));
    } finally {
      releaseHeld();
      await compaction.catch((err) =>
        console.error("Failed to finish the compaction during cleanup:", err),
      );
      session.dispose();
    }
  });
});
