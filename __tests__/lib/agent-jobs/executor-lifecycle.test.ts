import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Lifecycle tests for executeAgentRun.
 *
 * These drive the REAL event handling with a fake session, because the bug they
 * cover was invisible to the existing tests: the executor resolved on
 * `agent_end` (which fires once per attempt, before any retry) so a provider
 * failure  which does not throw  was reported as a completed run with empty
 * output, and any later rejection was a no-op on the settled promise.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockAgentRunMessageCreate = vi.fn();
const mockAppSettingsFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRunMessage: { create: (...args: unknown[]) => mockAgentRunMessageCreate(...args) },
    appSettings: { findUnique: (...args: unknown[]) => mockAppSettingsFindUnique(...args) },
  },
}));

vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn().mockResolvedValue({
    modelRuntime: { getModel: vi.fn().mockReturnValue({ id: "test-model" }) },
  }),
}));

vi.mock("@/lib/pi/tool-registry", () => ({
  resolveTools: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/pi/session", () => ({
  createTerminalScopedTools: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/pi/processing-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pi/processing-state")>()),
  createSystemPromptLoader: vi.fn().mockResolvedValue({}),
  // Extensions are not part of this lifecycle test; the executor only has to
  // start them, which is asserted in agent-extensions.test.ts.
  startSessionExtensions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  SessionManager: { inMemory: () => ({ getCwd: () => "/tmp/session" }) },
  // `createSessionSettings()` builds one of these per session.
  SettingsManager: { inMemory: () => ({}) },
}));

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { executeAgentRun, type AgentOutput } from "@/lib/agent-jobs/executor";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";

// ─── Fake session ────────────────────────────────────────────────────────────

type Listener = (event: Record<string, unknown>) => void;

function createFakeSession() {
  const listeners = new Set<Listener>();

  const session = {
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSessionStats: () => ({ tokens: { input: 11, output: 7 }, cost: 0.001 }),
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };

  return {
    session,
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

const DEFINITION = { prompt: "summarise my inbox", modelId: "custom:test-model" };

function setup() {
  const fake = createFakeSession();
  vi.mocked(createAgentSession).mockResolvedValue({
    session: fake.session,
  } as unknown as Awaited<ReturnType<typeof createAgentSession>>);
  mockAgentRunMessageCreate.mockResolvedValue({ id: "msg-1" });
  mockAppSettingsFindUnique.mockResolvedValue(null);
  return fake;
}

/** A provider failure: an assistant message that carries no content. */
const FAILED_MESSAGE = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: '400: {"message":"Invalid max_tokens value"}',
};

const TURN_END = {
  type: "turn_end",
  message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
  toolResults: [],
};

/**
 * Wrap the run promise so a test can assert it has NOT settled, without an
 * unhandled rejection if it later rejects.
 */
function track<T>(promise: Promise<T>) {
  let state: "pending" | "resolved" | "rejected" = "pending";
  const tracked = promise.then(
    (value) => {
      state = "resolved";
      return value;
    },
    (err) => {
      state = "rejected";
      throw err;
    },
  );
  tracked.catch(() => {});
  return { promise: tracked, state: () => state };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Start a run and wait until it has subscribed to the session.
 *
 * executeAgentRun awaits model/tool/session setup and writes the user prompt
 * before subscribing, so events emitted immediately would be lost.
 */
async function startRun(fake: ReturnType<typeof createFakeSession>) {
  const result = track(executeAgentRun("run-1", DEFINITION, "user-1"));
  await flush();
  if (fake.listenerCount() === 0) {
    throw new Error("executor never subscribed to the session");
  }
  return result;
}

describe("executeAgentRun  provider failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves with stats when the run succeeds", async () => {
    const fake = setup();
    const result = await startRun(fake);

    fake.emit({ type: "agent_start" });
    fake.emit(TURN_END);
    fake.emit({ type: "agent_end", messages: [], willRetry: false });
    fake.emit({ type: "agent_settled" });

    await expect(result.promise).resolves.toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.001,
    });
  });

  it("calls session.prompt, which is what produces agent_settled", async () => {
    const fake = setup();
    const result = await startRun(fake);

    // The SDK only runs retry/compaction/settle handling on session.prompt();
    // session.agent.prompt() never emits agent_settled, so the run could never
    // observe its own completion.
    expect(fake.session.prompt).toHaveBeenCalledWith("summarise my inbox", {
      expandPromptTemplates: false,
    });

    fake.emit({ type: "agent_settled" });
    await result.promise;
  });

  it("tells a job without its own system prompt how to reach hidden tools", async () => {
    const fake = setup();
    const result = await startRun(fake);

    // Job sessions resolve tools with the user's exposure too, so a job must
    // know that the tools it needs may be reachable only from codemode.
    const prompt = String(vi.mocked(createSystemPromptLoader).mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("You are an AI assistant executing an automated job");
    expect(prompt).toContain("Tool use:");
    expect(prompt).toContain("searchTools");

    fake.emit({ type: "agent_settled" });
    await result.promise;
  });

  it("leaves a job's own system prompt alone", async () => {
    const fake = setup();
    const result = track(
      executeAgentRun(
        "run-1",
        { ...DEFINITION, systemPrompt: "Custom job instructions." },
        "user-1",
      ),
    );
    await flush();

    expect(vi.mocked(createSystemPromptLoader).mock.calls[0]?.[0]).toBe("Custom job instructions.");

    fake.emit({ type: "agent_settled" });
    await result.promise;
  });

  it("rejects on a terminal provider failure instead of reporting success", async () => {
    const fake = setup();
    const result = await startRun(fake);

    fake.emit({ type: "agent_start" });
    fake.emit({ type: "turn_end", message: FAILED_MESSAGE, toolResults: [] });
    fake.emit({ type: "agent_end", messages: [FAILED_MESSAGE], willRetry: false });
    fake.emit({ type: "agent_settled" });

    await expect(result.promise).rejects.toThrow('400: {"message":"Invalid max_tokens value"}');
  });

  it("does not finish the run while a retry is pending", async () => {
    const fake = setup();
    const result = await startRun(fake);

    fake.emit({ type: "agent_start" });
    fake.emit({ type: "turn_end", message: FAILED_MESSAGE, toolResults: [] });
    // Transient failure: the SDK is about to retry, so the run is not over.
    fake.emit({ type: "agent_end", messages: [FAILED_MESSAGE], willRetry: true });
    await flush();

    expect(result.state()).toBe("pending");

    // The retry succeeds.
    fake.emit({ type: "agent_start" });
    fake.emit(TURN_END);
    fake.emit({ type: "agent_end", messages: [], willRetry: false });
    fake.emit({ type: "agent_settled" });

    await expect(result.promise).resolves.toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.001,
    });
  });

  it("rejects when the retry budget is exhausted", async () => {
    const fake = setup();
    const result = await startRun(fake);

    fake.emit({ type: "agent_start" });
    fake.emit({ type: "turn_end", message: FAILED_MESSAGE, toolResults: [] });
    fake.emit({ type: "agent_end", messages: [FAILED_MESSAGE], willRetry: true });
    fake.emit({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 1,
      delayMs: 2000,
      errorMessage: "503: service unavailable",
    });
    fake.emit({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "503: unavailable",
    });
    fake.emit({ type: "agent_settled" });

    await expect(result.promise).rejects.toThrow("503: unavailable");
  });

  it("keeps a non-terminal attempt's failure out of the run's outcome", async () => {
    const fake = setup();
    const result = await startRun(fake);

    // Attempt 1 fails with a non-retryable error, but the SDK schedules a retry.
    fake.emit({ type: "agent_start" });
    fake.emit({ type: "turn_end", message: FAILED_MESSAGE, toolResults: [] });
    fake.emit({ type: "agent_end", messages: [FAILED_MESSAGE], willRetry: true });

    // Attempt 2 succeeds  the run must be reported as completed.
    fake.emit({ type: "agent_start" });
    fake.emit(TURN_END);
    fake.emit({ type: "agent_end", messages: [], willRetry: false });
    fake.emit({ type: "agent_settled" });

    await expect(result.promise).resolves.toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.001,
    });
  });

  it("resolves the recovered answer after an overflow", async () => {
    const fake = setup();
    const result = await startRun(fake);

    // A context overflow reports `willRetry: false` (compaction handles it, not
    // retry) and is followed by a compact-and-continue. Reporting the error
    // would fail a run whose answer arrives a moment later.
    const overflow = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "This model's maximum context length is 128000 tokens",
    };
    fake.emit({ type: "agent_start" });
    fake.emit({ type: "turn_end", message: overflow, toolResults: [] });
    fake.emit({ type: "agent_end", messages: [overflow], willRetry: false });

    // The continuation produces the answer.
    fake.emit({ type: "agent_start" });
    fake.emit(TURN_END);
    fake.emit({ type: "agent_end", messages: [], willRetry: false });
    fake.emit({ type: "agent_settled" });

    await expect(result.promise).resolves.toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.001,
    });
  });

  it("disposes the session when the run settles", async () => {
    const fake = setup();
    const result = await startRun(fake);

    fake.emit({ type: "agent_start" });
    fake.emit(TURN_END);
    fake.emit({ type: "agent_end", messages: [], willRetry: false });
    fake.emit({ type: "agent_settled" });
    await result.promise;

    // dispose() cancels the cache warmer's timer and aborts the agent  without
    // it they stay alive after the run.
    expect(fake.session.dispose).toHaveBeenCalledTimes(1);
  });

  it("waits for the last turn's DB write before finishing", async () => {
    const fake = setup();
    // The user-prompt write succeeds; the turn write stays in flight.
    mockAgentRunMessageCreate.mockResolvedValueOnce({ id: "user-msg" });
    let releaseWrite: (value: { id: string }) => void = () => {};
    mockAgentRunMessageCreate.mockImplementationOnce(
      () =>
        new Promise<{ id: string }>((resolve) => {
          releaseWrite = resolve;
        }),
    );

    const result = await startRun(fake);

    fake.emit({ type: "agent_start" });
    fake.emit(TURN_END); // persists asynchronously, still in flight
    fake.emit({ type: "agent_end", messages: [], willRetry: false });
    fake.emit({ type: "agent_settled" });
    await flush();

    // The run must not be finished while its last message is still being saved.
    expect(result.state()).toBe("pending");

    releaseWrite({ id: "msg-1" });
    await expect(result.promise).resolves.toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cost: 0.001,
    });
  });

  it("logs a failed persistence instead of throwing unhandled", async () => {
    const fake = setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The user-prompt write succeeds, the turn write fails.
    mockAgentRunMessageCreate.mockResolvedValueOnce({ id: "user-msg" });
    mockAgentRunMessageCreate.mockRejectedValueOnce(new Error("db down"));

    try {
      const result = await startRun(fake);

      fake.emit({ type: "agent_start" });
      fake.emit(TURN_END);
      fake.emit({ type: "agent_end", messages: [], willRetry: false });
      fake.emit({ type: "agent_settled" });

      // The write failure is reported, and the run still finishes.
      await expect(result.promise).resolves.toEqual({
        inputTokens: 11,
        outputTokens: 7,
        cost: 0.001,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "[agent-job:run-1] Failed to persist agent event:",
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("rejects when the prompt itself fails", async () => {
    const fake = setup();
    fake.session.prompt.mockRejectedValue(new Error("no model"));

    const result = track(executeAgentRun("run-1", DEFINITION, "user-1"));
    await expect(result.promise).rejects.toThrow("no model");
  });

  it("stops listening once the run settles", async () => {
    const fake = setup();
    const result = await startRun(fake);

    fake.emit({ type: "agent_settled" });
    await result.promise;

    expect(fake.listenerCount()).toBe(0);
  });
});

describe("executeAgentRun  output delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Start a run with an output handler and wait for it to subscribe. */
  async function startRunWithOutput(
    fake: ReturnType<typeof createFakeSession>,
    output: AgentOutput,
  ) {
    const result = track(executeAgentRun("run-1", DEFINITION, "user-1", output));
    await flush();
    if (fake.listenerCount() === 0) {
      throw new Error("executor never subscribed to the session");
    }
    return result;
  }

  it("hands every finished tool call to the output handler", async () => {
    const fake = setup();
    const output: AgentOutput = { send: vi.fn(), noteToolCall: vi.fn() };
    const result = await startRunWithOutput(fake, output);

    // A tool-only turn produces no text, so `send` never sees this call  the
    // handler needs it to know the agent reached the user itself.
    fake.emit({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "telegram_send",
      args: { message: "Stand up" },
    });
    fake.emit({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "telegram_send",
      result: {
        content: [{ type: "text", text: "Sent to the user on Telegram." }],
        details: { chatId: "42" },
        structuredContent: { sent: true, chatId: "42" },
      },
      isError: false,
    });
    await flush();

    expect(output.noteToolCall).toHaveBeenCalledWith({
      name: "telegram_send",
      args: { message: "Stand up" },
      structured: { sent: true, chatId: "42" },
      isError: false,
    });

    fake.emit({ type: "agent_settled" });
    await result.promise;
  });

  it("reports a failed tool call as failed", async () => {
    const fake = setup();
    const output: AgentOutput = { send: vi.fn(), noteToolCall: vi.fn() };
    const result = await startRunWithOutput(fake, output);

    fake.emit({
      type: "tool_execution_end",
      toolCallId: "tc-2",
      toolName: "telegram_send",
      result: { content: [{ type: "text", text: "not delivered" }] },
      isError: true,
    });
    await flush();

    expect(output.noteToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ name: "telegram_send", isError: true }),
    );

    fake.emit({ type: "agent_settled" });
    await result.promise;
  });

  it("still routes assistant text to the handler", async () => {
    const fake = setup();
    const output: AgentOutput = { send: vi.fn(), noteToolCall: vi.fn() };
    const result = await startRunWithOutput(fake, output);

    fake.emit({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    });
    fake.emit(TURN_END);
    await flush();

    expect(output.send).toHaveBeenCalledWith("Done", {});
    expect(output.noteToolCall).not.toHaveBeenCalled();

    fake.emit({ type: "agent_settled" });
    await result.promise;
  });
});
