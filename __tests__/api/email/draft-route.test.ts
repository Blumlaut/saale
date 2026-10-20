import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The draft route streams an SSE response. Because a provider failure does not
 * throw  it ends the assistant message with stopReason "error"  the stream
 * used to emit `done` with empty text and close, so the UI reported a
 * successful, empty draft. A throw inside the listener (or a rejected prompt)
 * left the stream open forever instead.
 */

const {
  mockCreateAgentSession,
  mockResolveModelForPurpose,
  mockRequireSession,
  mockFindFirst,
  mockAppSettingsFindUnique,
} = vi.hoisted(() => ({
  mockCreateAgentSession: vi.fn(),
  mockResolveModelForPurpose: vi.fn(),
  mockRequireSession: vi.fn(),
  mockFindFirst: vi.fn(),
  mockAppSettingsFindUnique: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: { inMemory: () => ({ getCwd: () => "/tmp/session" }) },
  SettingsManager: { inMemory: () => ({}) },
}));

vi.mock("@/lib/auth", () => ({ requireSession: mockRequireSession }));

vi.mock("@/lib/db", () => ({
  prisma: {
    emailMessage: { findFirst: mockFindFirst },
    appSettings: { findUnique: mockAppSettingsFindUnique },
  },
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn().mockResolvedValue({
    modelRuntime: { getModel: vi.fn().mockReturnValue({ id: "test-model" }) },
  }),
}));
vi.mock("@/lib/pi/model-resolution", () => ({
  resolveModelForPurpose: mockResolveModelForPurpose,
}));
vi.mock("@/lib/pi/processing-state", () => ({
  createSystemPromptLoader: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/pi/settings", () => ({ createSessionSettings: () => ({}) }));

import { POST } from "@/app/api/email/draft/route";

type Listener = (event: Record<string, unknown>) => void;

function createFakeSession() {
  const listeners = new Set<Listener>();
  return {
    session: {
      subscribe: (listener: Listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    },
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

const ASSISTANT_TEXT = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const PROVIDER_FAILURE = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: '400: {"message":"Invalid max_tokens value"}',
};

/** Read an SSE body into `{ events: [{ event, data }] }`. */
async function readSse(response: Response) {
  const body = await response.text();
  const events: { event: string; data: unknown }[] = [];
  for (const block of body.split("\n\n")) {
    const eventLine = block.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length).replace(/\\n/g, "\n")),
    });
  }
  return events;
}

describe("POST /api/email/draft", () => {
  let fake: ReturnType<typeof createFakeSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fake.session });
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mockResolveModelForPurpose.mockResolvedValue({ provider: "custom", name: "test-model" });
    mockFindFirst.mockResolvedValue({
      id: "msg-1",
      fromName: "Ada",
      fromEmail: "ada@example.com",
      to: "me@example.com",
      subject: "Hello",
      bodyText: "Hi there",
      bodyHtml: null,
      bodyPreview: null,
      date: new Date("2026-01-01T00:00:00Z"),
    });
    mockAppSettingsFindUnique.mockResolvedValue(null);
  });

  function request() {
    return POST(
      new Request("http://localhost/api/email/draft", {
        method: "POST",
        body: JSON.stringify({ messageId: "msg-1", mode: "reply" }),
      }) as never,
    );
  }

  /** Start the draft and wait until it is subscribed and prompted. */
  async function start() {
    const response = await request();
    await vi.waitFor(() => expect(fake.session.prompt).toHaveBeenCalled());
    // The prompt runs the SDK's own lifecycle (importantly `agent_settled`).
    expect(fake.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("Reply to this email"),
      {
        expandPromptTemplates: false,
      },
    );
    // Collected concurrently: the body only finishes once the run's events land,
    // so the caller must be able to emit them while this promise is pending.
    return { events: readSse(response) };
  }

  it("streams tokens and a done event with the finished draft", async () => {
    const { events } = await start();

    fake.emit({
      type: "message_update",
      message: ASSISTANT_TEXT("Hi Ada, sounds good."),
    });
    fake.emit({ type: "agent_end", messages: [ASSISTANT_TEXT("Hi Ada, sounds good.")] });
    fake.emit({ type: "agent_settled" });

    const result = await events;
    expect(result.map((e) => e.event)).toEqual(["token", "done"]);
    expect(result[1]?.data).toEqual({ text: "Hi Ada, sounds good." });
  });

  it("reports a provider failure instead of a successful empty draft", async () => {
    const { events } = await start();

    fake.emit({ type: "agent_end", messages: [PROVIDER_FAILURE], willRetry: false });
    fake.emit({ type: "agent_settled" });

    const result = await events;
    expect(result.map((e) => e.event)).toEqual(["error"]);
    expect(result[0]?.data).toEqual({ error: '400: {"message":"Invalid max_tokens value"}' });
  });

  it("delivers the recovering draft after an overflow", async () => {
    const { events } = await start();

    // An overflow reports `willRetry: false` and is followed by a
    // compact-and-continue, so the draft arrives after the failure.
    fake.emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "This model's maximum context length is 128000 tokens",
        },
      ],
      willRetry: false,
    });
    fake.emit({
      type: "agent_end",
      messages: [ASSISTANT_TEXT("Recovered draft")],
      willRetry: false,
    });
    fake.emit({ type: "agent_settled" });

    const result = await events;
    expect(result.at(-1)).toEqual({ event: "done", data: { text: "Recovered draft" } });
  });

  it("reports a failed prompt instead of leaving the stream open", async () => {
    fake.session.prompt.mockRejectedValue(new Error("No API key for custom"));
    const { events } = await start();

    const result = await events;
    expect(result).toEqual([{ event: "error", data: { error: "No API key for custom" } }]);
  });

  it("releases the session and its listener when the draft ends", async () => {
    const { events } = await start();

    fake.emit({ type: "agent_settled" });
    await events;

    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(0);
  });
});
