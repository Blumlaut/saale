import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import {
  ModelRuntime,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

/**
 * A run end to end, with only the model mocked: Pi's own streaming deltas →
 * the session event tracker → the Redis event bus and replay buffer → the SSE
 * dispatcher → the frames a browser receives → the real client wiring and
 * reducer → the transcript.
 *
 * What it guards is the shape of the stream, not a renderer: a growing text
 * block is published as chunks with a full snapshot once a second, and the
 * client that applies those frames must end up with exactly what the model
 * wrote. Re-sending the whole block per token also used to mean a long
 * reasoning trace spent its bandwidth on the same characters again and again,
 * which is what the byte budgets below pin down.
 */

vi.mock("@/lib/redis", () => import("../../helpers/in-memory-redis"));

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: { update: vi.fn().mockResolvedValue({}) },
    chatMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

vi.mock("@/lib/chat/queue", () => ({
  publishQueueUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/chat/compaction", () => ({
  saveCompactionMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pi/stream-helpers", () => ({
  saveAssistantMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
}));

import { resetMockRedis } from "../../helpers/in-memory-redis";
import { resetSessionEvents } from "@/lib/pi/session-events";
import { createSessionEventTracker } from "@/lib/pi/session-event-tracker";
import { SseDispatcher } from "@/lib/pi/sse-dispatcher";
import { wireStreamListeners } from "@/components/chat/use-chat-stream";
import type { Message } from "@/components/chat/types";

// ─── Mock provider ──────────────────────────────────────────────────────────

const CHUNKS = 40;
const REASONING_CHUNKS = Array.from(
  { length: CHUNKS },
  (_, i) => `step ${i} of the plan, weighing what the answer needs. `,
);
const ANSWER_CHUNKS = Array.from(
  { length: CHUNKS },
  (_, i) => `word${i} and then some more of the answer text. `,
);

function chunk(delta: { content?: string; reasoning_content?: string }): string {
  return `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta }],
  })}\n\n`;
}

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const text of REASONING_CHUNKS) res.write(chunk({ reasoning_content: text }));
    for (const text of ANSWER_CHUNKS) res.write(chunk({ content: text }));
    res.end(
      `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
});

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
        reasoning: true,
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  resetMockRedis();
  await resetSessionEvents("session-1");
});

// ─── The pipeline ───────────────────────────────────────────────────────────

interface Frame {
  id: number | null;
  event: string;
  data: unknown;
}

/** The SSE frames a client received, as the browser would parse them. */
function parseFrames(chunks: Uint8Array[]): Frame[] {
  const text = chunks.map((c) => new TextDecoder().decode(c)).join("");
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const field = (name: string) =>
        lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      return {
        id: field("id") === undefined ? null : Number(field("id")),
        event: field("event") ?? "message",
        data: JSON.parse(field("data") ?? "null") as unknown,
      };
    });
}

/** A stand-in for the browser's EventSource, fed from the frames above. */
class FakeEventSource {
  listeners = new Map<string, EventListener[]>();
  onerror: ((event?: unknown) => void) | null = null;

  addEventListener(type: string, listener: EventListener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close() {}

  emit(frame: Frame) {
    const payload = { data: JSON.stringify(frame.data) };
    for (const listener of this.listeners.get(frame.event) ?? []) {
      listener(payload as unknown as Event);
    }
  }
}

function createClient() {
  const eventSource = new FakeEventSource();
  let messages: Message[] = [];
  wireStreamListeners({
    eventSource: eventSource as unknown as EventSource,
    rootMessageIdRef: { current: null },
    sessionId: "session-1",
    eventSourceRef: { current: null },
    setMessages: (update) => {
      messages = typeof update === "function" ? update(messages) : update;
    },
    setIsLoading: () => {},
    setPendingApprovals: () => {},
    setPluginDialogs: () => {},
    markDone: () => {},
    onReload: () => {},
  });
  return { eventSource, messages: () => messages };
}

const reasoning = REASONING_CHUNKS.join("");
const answer = ANSWER_CHUNKS.join("");
/** What the stream costs if every token re-sends the whole block. */
const cumulativeCost = (chunks: string[]) =>
  chunks.reduce((total, _chunk, index) => total + chunks.slice(0, index + 1).join("").length, 0);

/** Bytes of payload in the frames that carry a growing text block. */
function payloadBytes(frames: Frame[], events: string[]): number {
  return frames
    .filter((frame) => events.includes(frame.event))
    .reduce((total, frame) => total + JSON.stringify(frame.data).length, 0);
}

describe("a run end to end (real SDK, mocked model)", () => {
  it("carries the text as chunks and still lands the whole block on the client", async () => {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRuntime: runtime,
      noTools: "builtin",
      model: TEST_MODEL,
      customTools: [],
      resourceLoader: await createSystemPromptLoader("You are a test.", process.cwd()),
      thinkingLevel: "low",
    });

    const chunks: Uint8Array[] = [];
    const controller = {
      enqueue: (chunk: Uint8Array) => {
        chunks.push(chunk);
      },
      close: () => {},
    } as unknown as ReadableStreamDefaultController;

    const dispatcher = new SseDispatcher("session-1");
    await dispatcher.subscribe(controller, new TextEncoder(), -1);

    const tracker = createSessionEventTracker({
      sessionId: "session-1",
      userId: "user-1",
      session,
    });

    try {
      await session.prompt("plan the answer");

      // The `done` on the stream is what settles a client, so wait for it
      // rather than for the prompt: a run can continue after it resolves.
      await vi.waitFor(
        () => {
          expect(parseFrames(chunks).some((frame) => frame.event === "done")).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );

      const frames = parseFrames(chunks);

      // The stream really is chunked, and snapshots still appear.
      expect(frames.filter((frame) => frame.event === "thinking_delta").length).toBeGreaterThan(5);
      expect(frames.filter((frame) => frame.event === "token_delta").length).toBeGreaterThan(5);
      expect(frames.some((frame) => frame.event === "thinking")).toBe(true);
      expect(frames.some((frame) => frame.event === "token")).toBe(true);

      // What the browser assembles from those frames is what the model wrote.
      const client = createClient();
      for (const frame of frames) client.eventSource.emit(frame);

      const [message] = client.messages();
      expect(message?.content).toBe(answer);
      expect(message?.thinking).toBe(reasoning);

      // And it cost the text's length, not its square: re-sending the block
      // with every chunk would be a full order of magnitude more on a run this
      // size, and grows with the block.
      const textBytes = payloadBytes(frames, ["token", "token_delta"]);
      const reasoningBytes = payloadBytes(frames, ["thinking", "thinking_delta"]);
      expect(textBytes).toBeLessThan(cumulativeCost(ANSWER_CHUNKS) / 4);
      expect(reasoningBytes).toBeLessThan(cumulativeCost(REASONING_CHUNKS) / 4);
    } finally {
      tracker.dispose();
      dispatcher.unsubscribe(controller);
      await dispatcher.dispose();
    }
  }, 30_000);
});
