import { beforeEach, describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */

const hoisted = vi.hoisted(() => ({
  configured: true,
  loopOutcome: {
    stopReason: "no-pending-work",
    error: null,
    awaitingUser: false,
    turnCount: 2,
    inputTokens: 10,
    outputTokens: 5,
    cost: 0.001,
  },
}));

vi.mock("@/lib/sandbox/client", () => ({
  isConfigured: () => hoisted.configured,
}));

vi.mock("@/lib/council/session", () => ({
  createCouncilMemberSession: vi.fn(),
}));

vi.mock("@/lib/council/sandbox", () => ({
  ensureCouncilSandbox: vi.fn(async () => {}),
  createCouncilSandbox: vi.fn(),
  councilSandboxTools: vi.fn(),
  normalizeSandboxPath: vi.fn(),
  resolveSandboxPath: vi.fn(),
}));

vi.mock("@/lib/council/persist", () => ({
  beginRun: vi.fn(),
  failStaleRuns: vi.fn(),
  finishRun: vi.fn(),
  finishMemberTurn: vi.fn(),
  lastRoomSeq: vi.fn(async () => 0),
  loadCouncil: vi.fn(),
  markSandboxReady: vi.fn(),
  postRoomMessage: vi.fn(),
  readRoomMessages: vi.fn(),
  readRoomWindow: vi.fn(),
  setCouncilStatus: vi.fn(),
  startMemberTurn: vi.fn(),
  touchRun: vi.fn(),
}));

vi.mock("@/lib/council/events", () => ({
  publishCouncilEvent: vi.fn(async () => {}),
  publishRoomMessage: vi.fn(async () => {}),
}));

vi.mock("@/lib/council/abort", () => ({
  clearCouncilAbort: vi.fn(async () => {}),
  isCouncilAbortRequested: vi.fn(async () => false),
  requestCouncilAbort: vi.fn(async () => {}),
}));

vi.mock("@/lib/council/orchestrator", () => ({
  runCouncilLoop: vi.fn(async () => hoisted.loopOutcome),
}));

vi.mock("@/lib/council/store", () => ({
  findRunningRun: vi.fn(async () => null),
}));

import { ensureCouncilSandbox } from "@/lib/council/sandbox";
import { findRunningRun } from "@/lib/council/store";
import { publishCouncilEvent } from "@/lib/council/events";
import { requestCouncilAbort } from "@/lib/council/abort";
import { runCouncilLoop } from "@/lib/council/orchestrator";
import {
  beginRun,
  finishRun,
  lastRoomSeq,
  loadCouncil,
  markSandboxReady,
  setCouncilStatus,
} from "@/lib/council/persist";
import {
  abortCouncilRun,
  CouncilBusyError,
  CouncilNotFoundError,
  CouncilUnavailableError,
  startCouncilRun,
  sweepCouncilRuns,
} from "@/lib/council/run";

const council = (overrides: Record<string, unknown> = {}) => ({
  council: {
    id: "council-1",
    userId: "user-1",
    name: "Launch review",
    brief: "Decide whether the migration is safe.",
    orchestration: "parallel",
    stopVoteThreshold: "majority",
    toolConfig: { terminal: true },
    maxDurationSeconds: null,
    maxTokens: null,
    maxCostUsd: null,
    sandboxKey: "abcd1234",
    sandboxReady: false,
    status: "idle",
    ...overrides,
  },
  members: [
    {
      id: "m1",
      name: "acorn",
      enabled: true,
      instructions: null,
      modelProvider: "anthropic",
      modelName: "claude-x",
      thinkingLevel: "default",
      toolConfig: null,
    },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.configured = true;
  vi.mocked(loadCouncil).mockResolvedValue(council() as any);
  vi.mocked(beginRun).mockResolvedValue({ runId: "run-1" });
  vi.mocked(finishRun).mockResolvedValue(undefined);
  vi.mocked(setCouncilStatus).mockResolvedValue(undefined);
  vi.mocked(ensureCouncilSandbox).mockResolvedValue(undefined);
  vi.mocked(runCouncilLoop).mockResolvedValue(hoisted.loopOutcome as any);
});

describe("startCouncilRun", () => {
  it("refuses a council that is not this user's", async () => {
    vi.mocked(loadCouncil).mockResolvedValue(null);
    await expect(startCouncilRun({ councilId: "council-1", userId: "user-1" })).rejects.toThrow(
      CouncilNotFoundError,
    );
    expect(beginRun).not.toHaveBeenCalled();
  });

  it("refuses a council with no enabled members", async () => {
    vi.mocked(loadCouncil).mockResolvedValue({
      ...council(),
      members: [{ ...council().members[0]!, enabled: false }],
    } as any);
    await expect(startCouncilRun({ councilId: "council-1", userId: "user-1" })).rejects.toThrow(
      CouncilUnavailableError,
    );
    expect(beginRun).not.toHaveBeenCalled();
  });

  it("refuses to start a second run while one holds the slot", async () => {
    vi.mocked(beginRun).mockResolvedValue(null);
    await expect(startCouncilRun({ councilId: "council-1", userId: "user-1" })).rejects.toThrow(
      CouncilBusyError,
    );
    expect(runCouncilLoop).not.toHaveBeenCalled();
  });

  it("prepares the sandbox before the first turn can pay for one", async () => {
    await startCouncilRun({ councilId: "council-1", userId: "user-1" });
    expect(ensureCouncilSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ key: "abcd1234", id: "council-abcd1234" }),
    );
    expect(markSandboxReady).toHaveBeenCalledWith("council-1", "user-1");
  });

  it("skips the sandbox when the council has no terminal tools", async () => {
    vi.mocked(loadCouncil).mockResolvedValue(council({ toolConfig: { terminal: false } }) as any);
    await startCouncilRun({ councilId: "council-1", userId: "user-1" });
    expect(ensureCouncilSandbox).not.toHaveBeenCalled();
    expect(runCouncilLoop).toHaveBeenCalled();
  });

  it("fails the run and releases the council when the sandbox cannot start", async () => {
    vi.mocked(ensureCouncilSandbox).mockRejectedValue(new Error("container is down"));

    await expect(startCouncilRun({ councilId: "council-1", userId: "user-1" })).rejects.toThrow(
      /container is down/,
    );
    expect(finishRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "failed", error: "container is down" }),
    );
    expect(setCouncilStatus).toHaveBeenCalledWith("council-1", "user-1", "idle");
    expect(runCouncilLoop).not.toHaveBeenCalled();
  });

  it("refuses to run a file-using council on a deployment without a sandbox", async () => {
    hoisted.configured = false;
    await expect(startCouncilRun({ councilId: "council-1", userId: "user-1" })).rejects.toThrow(
      /SANDBOX_URL/,
    );
    expect(runCouncilLoop).not.toHaveBeenCalled();
  });

  it("hands the loop the council's own configuration and budget", async () => {
    vi.mocked(loadCouncil).mockResolvedValue(
      council({ maxTokens: 500, maxCostUsd: 2, maxDurationSeconds: 120 }) as any,
    );

    await startCouncilRun({ councilId: "council-1", userId: "user-1" });

    const plan = vi.mocked(runCouncilLoop).mock.calls[0]![0];
    expect(plan).toMatchObject({
      councilId: "council-1",
      userId: "user-1",
      runId: "run-1",
      councilName: "Launch review",
      brief: "Decide whether the migration is safe.",
      orchestration: "parallel",
      stopVoteThreshold: "majority",
      sandboxKey: "abcd1234",
      budget: { maxDurationSeconds: 120, maxTokens: 500, maxCostUsd: 2 },
    });
  });

  it("lets a run override its budget without losing the council's other ceilings", async () => {
    vi.mocked(loadCouncil).mockResolvedValue(council({ maxTokens: 500, maxCostUsd: 2 }) as any);

    await startCouncilRun({
      councilId: "council-1",
      userId: "user-1",
      budget: { maxCostUsd: 0.5 },
    });

    const plan = vi.mocked(runCouncilLoop).mock.calls[0]![0];
    expect(plan.budget).toEqual({ maxDurationSeconds: 1800, maxTokens: 500, maxCostUsd: 0.5 });
  });

  it("wakes the members the opening message addressed", async () => {
    await startCouncilRun({
      councilId: "council-1",
      userId: "user-1",
      openingMemberIds: ["m1"],
      triggerMessageId: "msg-1",
    });

    const plan = vi.mocked(runCouncilLoop).mock.calls[0]![0];
    expect(plan.openingMemberIds).toEqual(["m1"]);
    expect(beginRun).toHaveBeenCalledWith(expect.objectContaining({ triggerMessageId: "msg-1" }));
  });

  it("reads the room's position before taking the slot, so a racing message is absorbed", async () => {
    // The loop absorbs everything after this seq. Read after the reservation
    // instead, and a message the owner sent while the slot was being taken (and
    // which found the council busy) would be seen by nobody.
    vi.mocked(lastRoomSeq).mockResolvedValue(12);

    await startCouncilRun({ councilId: "council-1", userId: "user-1" });

    expect(vi.mocked(lastRoomSeq).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(beginRun).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(runCouncilLoop).mock.calls[0]![0].startedAfterSeq).toBe(12);
  });

  it("announces the run, then records its outcome and releases the council", async () => {
    const started = await startCouncilRun({ councilId: "council-1", userId: "user-1" });
    expect(started).toEqual({ runId: "run-1" });

    // The run is dispatched, so wait for its last visible effect.
    await vi.waitFor(() => {
      expect(publishCouncilEvent).toHaveBeenCalledWith(
        "council-1",
        "run_ended",
        expect.objectContaining({ runId: "run-1" }),
      );
    });

    expect(finishRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "completed", stopReason: "no-pending-work" }),
    );
    expect(setCouncilStatus).toHaveBeenLastCalledWith("council-1", "user-1", "idle");
    expect(publishCouncilEvent).toHaveBeenCalledWith(
      "council-1",
      "run_started",
      expect.objectContaining({ runId: "run-1" }),
    );
  });

  it("leaves the council waiting when a member asked the owner a question", async () => {
    vi.mocked(runCouncilLoop).mockResolvedValue({
      ...hoisted.loopOutcome,
      stopReason: "user-question",
      awaitingUser: true,
    } as any);

    await startCouncilRun({ councilId: "council-1", userId: "user-1" });
    await vi.waitFor(() => {
      expect(setCouncilStatus).toHaveBeenCalledWith("council-1", "user-1", "waiting");
    });

    expect(finishRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "waiting", stopReason: "user-question" }),
    );
  });

  it("marks an aborted run as aborted, not as a failure", async () => {
    vi.mocked(runCouncilLoop).mockResolvedValue({
      ...hoisted.loopOutcome,
      stopReason: "aborted",
    } as any);

    await startCouncilRun({ councilId: "council-1", userId: "user-1" });
    await vi.waitFor(() => {
      expect(finishRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ status: "aborted" }),
      );
    });
  });
});

describe("abortCouncilRun", () => {
  it("asks the run that is holding the council to stop", async () => {
    vi.mocked(findRunningRun).mockResolvedValue({ id: "run-7" } as any);

    const result = await abortCouncilRun({ councilId: "council-1", userId: "user-1" });

    expect(result).toEqual({ runId: "run-7" });
    expect(requestCouncilAbort).toHaveBeenCalledWith("run-7");
    // Scoped to the user, so another account's run cannot be stopped by id.
    expect(findRunningRun).toHaveBeenCalledWith("user-1", "council-1");
  });

  it("reports nothing to stop when the council is idle", async () => {
    vi.mocked(findRunningRun).mockResolvedValue(null);
    expect(await abortCouncilRun({ councilId: "council-1", userId: "user-1" })).toBeNull();
    expect(requestCouncilAbort).not.toHaveBeenCalled();
  });
});

describe("sweepCouncilRuns", () => {
  it("reports how many abandoned runs it released", async () => {
    const persist = await import("@/lib/council/persist");
    vi.mocked(persist.failStaleRuns).mockResolvedValue(2);

    expect(await sweepCouncilRuns(90_000)).toEqual({ failed: 2 });
    expect(persist.failStaleRuns).toHaveBeenCalledWith(90_000);
  });
});
