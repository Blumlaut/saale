import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `dispatchAiJob` is the one-shot AI path for queue jobs (email classification,
 * spam filtering, task extraction, …). It used to resolve on `agent_end`, and a
 * provider failure does not throw  it ends the assistant message with
 * stopReason "error". A failed job therefore resolved the empty string, the run
 * was marked completed, and callers silently no-op'd (`JSON.parse("")` → catch →
 * no results).
 */

const { mockCreateAgentSession, mockResolveModel } = vi.hoisted(() => ({
  mockCreateAgentSession: vi.fn(),
  mockResolveModel: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: mockCreateAgentSession,
    SessionManager: { inMemory: () => ({ getCwd: () => "/tmp/session" }) },
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { queueTask: { findUnique: vi.fn(), update: vi.fn() }, taskRun: { update: vi.fn() } },
}));
const { mockHandlerMap } = vi.hoisted(() => ({ mockHandlerMap: new Map<string, unknown>() }));
vi.mock("@/lib/queue", () => ({
  getQueue: vi.fn(),
  addJobRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateJobRun: vi.fn(),
  pruneTaskRuns: vi.fn().mockResolvedValue(undefined),
  queueTaskSchedulerId: vi.fn(),
}));
vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn().mockResolvedValue({
    modelRuntime: { getModel: vi.fn().mockReturnValue({ id: "test-model" }) },
  }),
}));
vi.mock("@/lib/pi/model-resolution", () => ({ resolveModelForPurpose: mockResolveModel }));
vi.mock("@/lib/pi/processing-state", () => ({
  createSystemPromptLoader: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/queue/jobs/registry", () => ({ handlerMap: mockHandlerMap }));

import { prisma } from "@/lib/db";
import { addJobRun, pruneTaskRuns, updateJobRun } from "@/lib/queue";
import { handlerMap } from "@/lib/queue/jobs/registry";
import { dispatchAiJob, processJob } from "@/lib/queue/job-handler";
import type { Job } from "bullmq";

type Listener = (event: Record<string, unknown>) => void;

function createFakeSession() {
  const listeners = new Set<Listener>();
  const session = {
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    agent: { prompt: vi.fn().mockResolvedValue(undefined) },
  };
  return {
    session,
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function assistantMessage(content: unknown[], extra: Record<string, unknown> = {}) {
  return { role: "assistant", content, ...extra };
}

/** The run's outcome, captured as a value so no rejection goes unhandled. */
type Outcome = { ok: true; text: string } | { ok: false; error: string };

describe("dispatchAiJob", () => {
  let fake: ReturnType<typeof createFakeSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fake.session });
    mockResolveModel.mockResolvedValue({ provider: "custom", name: "test-model" });
  });

  /** Start a job, capturing its outcome as a value (no unhandled rejections). */
  function start(): Promise<Outcome> {
    return dispatchAiJob("user-1", "classify this email").then(
      (text) => ({ ok: true as const, text }),
      (err: Error) => ({ ok: false as const, error: err.message }),
    );
  }

  /** Wait until the job's session exists and is subscribed. */
  async function waitForSession(): Promise<void> {
    await vi.waitFor(() => expect(mockCreateAgentSession).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("resolves the text produced once the run settles", async () => {
    const outcome = start();
    await waitForSession();

    fake.emit({
      type: "agent_end",
      willRetry: false,
      messages: [assistantMessage([{ type: "text", text: '{"results":[]}' }])],
    });
    fake.emit({ type: "agent_settled" });

    await expect(outcome).resolves.toEqual({ ok: true, text: '{"results":[]}' });
  });

  it("rejects when the provider failed instead of resolving an empty string", async () => {
    const outcome = start();
    await waitForSession();

    fake.emit({
      type: "agent_end",
      willRetry: false,
      messages: [
        assistantMessage([], {
          stopReason: "error",
          errorMessage: '400: {"message":"Invalid max_tokens value"}',
        }),
      ],
    });
    fake.emit({ type: "agent_settled" });

    await expect(outcome).resolves.toEqual({
      ok: false,
      error: '400: {"message":"Invalid max_tokens value"}',
    });
  });

  it("does not settle on agent_end, which fires before retries finish", async () => {
    const outcome = start();
    await waitForSession();

    fake.emit({
      type: "agent_end",
      willRetry: true,
      messages: [assistantMessage([], { stopReason: "error", errorMessage: "overloaded" })],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The retry succeeded.
    fake.emit({
      type: "agent_end",
      willRetry: false,
      messages: [assistantMessage([{ type: "text", text: '{"ok":true}' }])],
    });
    fake.emit({ type: "agent_settled" });

    await expect(outcome).resolves.toEqual({ ok: true, text: '{"ok":true}' });
  });

  it("resolves the recovered answer after an overflow", async () => {
    // A context overflow arrives as a provider error with `willRetry: false`,
    // but the SDK compacts and continues: reporting it as the outcome would fail
    // a job whose answer arrives a moment later.
    const outcome = start();
    await waitForSession();

    fake.emit({
      type: "agent_end",
      willRetry: false,
      messages: [
        assistantMessage([], {
          stopReason: "error",
          errorMessage: "This model's maximum context length is 128000 tokens",
        }),
      ],
    });
    fake.emit({
      type: "agent_end",
      willRetry: false,
      messages: [assistantMessage([{ type: "text", text: '{"results":[1]}' }])],
    });
    fake.emit({ type: "agent_settled" });

    await expect(outcome).resolves.toEqual({ ok: true, text: '{"results":[1]}' });
  });

  it("drives the run through session.prompt, not session.agent.prompt", async () => {
    start();
    await waitForSession();
    // agent.prompt() bypasses the session's preflight compaction, retry and
    // overflow recovery  and never emits agent_settled, so a job would hang.
    expect(fake.session.prompt).toHaveBeenCalledWith("classify this email", {
      expandPromptTemplates: false,
    });
    expect(fake.session.agent.prompt).not.toHaveBeenCalled();
  });

  it("rejects when the prompt itself fails", async () => {
    fake.session.prompt.mockRejectedValue(new Error("No API key for custom"));
    const outcome = start();
    await waitForSession();

    await expect(outcome).resolves.toEqual({ ok: false, error: "No API key for custom" });
  });
});

/**
 * `processJob` is what the worker runs for a QueueTask now, so its record
 * keeping (a run row per fire, and the prune that keeps that table bounded) is
 * the part worth pinning.
 */
describe("processJob", () => {
  const handlers = handlerMap as unknown as Map<string, { handler: unknown }>;

  function queueJob(data: Record<string, unknown>): Job {
    return { id: "1", name: "execute", data } as unknown as Job;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    vi.mocked(prisma.queueTask.findUnique).mockResolvedValue({ userId: "user-1" } as never);
    vi.mocked(prisma.queueTask.update).mockResolvedValue({} as never);
    vi.mocked(addJobRun).mockResolvedValue({ id: "run-1" });
    vi.mocked(pruneTaskRuns).mockResolvedValue(undefined);
  });

  it("records the run and then drops the task's oldest runs", async () => {
    const handler = vi.fn().mockResolvedValue('{"ok":true}');
    handlers.set("email_sync", { handler });

    await processJob(queueJob({ taskId: "task-1", type: "email_sync", accountId: "acc-1" }));

    expect(handler).toHaveBeenCalledWith({
      config: { accountId: "acc-1" },
      userId: "user-1",
      modelId: undefined,
    });
    expect(updateJobRun).toHaveBeenCalledWith("run-1", {
      status: "completed",
      output: '{"ok":true}',
      completedAt: expect.any(Date),
    });
    expect(pruneTaskRuns).toHaveBeenCalledWith("task-1");
  });

  it("marks the run failed and still prunes", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("imap down"));
    handlers.set("email_sync", { handler });

    await expect(processJob(queueJob({ taskId: "task-1", type: "email_sync" }))).rejects.toThrow(
      "imap down",
    );

    expect(updateJobRun).toHaveBeenCalledWith("run-1", {
      status: "error",
      error: "imap down",
      completedAt: expect.any(Date),
    });
    expect(pruneTaskRuns).toHaveBeenCalledWith("task-1");
  });
});
