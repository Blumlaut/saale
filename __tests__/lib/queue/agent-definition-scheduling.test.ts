import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared mock queue instance — `getQueue()` must return the same instance
// every call so assertions can observe `upsertJobScheduler`/`add`.
const {
  mockAdd,
  mockRemove,
  mockRemoveJobScheduler,
  mockUpsertJobScheduler,
  mockGetJobSchedulers,
} = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockRemove: vi.fn(),
  mockRemoveJobScheduler: vi.fn(),
  mockUpsertJobScheduler: vi.fn(),
  mockGetJobSchedulers: vi.fn(),
}));

// Mock Prisma — factory must be self-contained (hoisted to top of file)
vi.mock("@/lib/db", () => ({
  prisma: {
    agentDefinition: {
      findMany: vi.fn(),
    },
  },
}));

// Mock the queue instance (no real Redis in tests)
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    // `new Queue(...)` must return the same shared mocks every time
    return {
      add: mockAdd,
      remove: mockRemove,
      removeJobScheduler: mockRemoveJobScheduler,
      upsertJobScheduler: mockUpsertJobScheduler,
      getJobSchedulers: mockGetJobSchedulers,
    };
  }),
}));

import { prisma } from "@/lib/db";
import {
  agentOnceJobId,
  agentSchedulerId,
  scheduleAgentDefinition,
  unscheduleAgentDefinition,
  syncAgentDefinitionSchedule,
  scheduleAllAgentDefinitions,
} from "@/lib/queue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentDefinitionFindMany = vi.mocked(prisma.agentDefinition.findMany as any);

describe("agent definition scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdd.mockResolvedValue({});
    mockRemove.mockResolvedValue(1);
    mockRemoveJobScheduler.mockResolvedValue(undefined);
    mockUpsertJobScheduler.mockResolvedValue({});
    mockGetJobSchedulers.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("agentSchedulerId", () => {
    it("namespaces agent schedulers separately from QueueTask schedulers", () => {
      expect(agentSchedulerId("def-1")).toBe("agent-scheduled-def-1");
      expect(agentSchedulerId("def-1")).not.toBe("scheduled-def-1");
    });
  });

  describe("agentOnceJobId", () => {
    it("namespaces one-off jobs so they can't collide with schedulers", () => {
      expect(agentOnceJobId("def-1")).toBe("agent-once-def-1");
      expect(agentOnceJobId("def-1")).not.toBe(agentSchedulerId("def-1"));
    });
  });

  describe("scheduleAgentDefinition", () => {
    it("registers an agent_execute job scheduler with the cron pattern", async () => {
      await scheduleAgentDefinition({
        id: "def-1",
        enabled: true,
        cronExpression: "0 15 * * *",
        runAt: null,
      });

      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "agent-scheduled-def-1",
        { pattern: "0 15 * * *", tz: "UTC" },
        { name: "agent_execute", data: { definitionId: "def-1" } },
      );
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("does nothing when the definition has no cron expression or runAt", async () => {
      await scheduleAgentDefinition({
        id: "def-1",
        enabled: true,
        cronExpression: null,
        runAt: null,
      });
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("does nothing when the definition is disabled", async () => {
      await scheduleAgentDefinition({
        id: "def-1",
        enabled: false,
        cronExpression: "0 15 * * *",
        runAt: new Date(Date.now() + 60_000),
      });
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("enqueues a delayed one-off job for runAt (no cron)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      await scheduleAgentDefinition({
        id: "def-1",
        enabled: true,
        cronExpression: null,
        runAt: new Date("2026-01-01T01:30:00Z"),
      });

      expect(mockAdd).toHaveBeenCalledWith(
        "agent_execute",
        { definitionId: "def-1" },
        {
          jobId: "agent-once-def-1",
          delay: 90 * 60 * 1000,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });

    it("prefers a one-off runAt over a cron expression", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      await scheduleAgentDefinition({
        id: "def-1",
        enabled: true,
        cronExpression: "0 * * * *",
        runAt: new Date("2026-01-01T00:10:00Z"),
      });

      expect(mockAdd).toHaveBeenCalledWith(
        "agent_execute",
        { definitionId: "def-1" },
        expect.objectContaining({ delay: 10 * 60 * 1000 }),
      );
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });

    it("fires immediately (delay 0) when runAt is in the past", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));

      await scheduleAgentDefinition({
        id: "def-1",
        enabled: true,
        cronExpression: null,
        runAt: new Date("2026-01-01T09:00:00Z"),
      });

      expect(mockAdd).toHaveBeenCalledWith(
        "agent_execute",
        { definitionId: "def-1" },
        expect.objectContaining({ delay: 0 }),
      );
    });
  });

  describe("unscheduleAgentDefinition", () => {
    it("removes both the recurring scheduler and the one-off job", async () => {
      await unscheduleAgentDefinition("def-1");
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("agent-scheduled-def-1");
      expect(mockRemove).toHaveBeenCalledWith("agent-once-def-1");
    });

    it("swallows errors from removeJobScheduler (scheduler may not exist)", async () => {
      mockRemoveJobScheduler.mockRejectedValue(new Error("not found"));
      await expect(unscheduleAgentDefinition("def-1")).resolves.toBeUndefined();
    });
  });

  describe("syncAgentDefinitionSchedule", () => {
    it("removes the old scheduler then re-adds when scheduled", async () => {
      await syncAgentDefinitionSchedule({
        id: "def-1",
        enabled: true,
        cronExpression: "0 9 * * *",
        runAt: null,
      });

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("agent-scheduled-def-1");
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "agent-scheduled-def-1",
        expect.objectContaining({ pattern: "0 9 * * *" }),
        expect.objectContaining({
          name: "agent_execute",
          data: { definitionId: "def-1" },
        }),
      );
      // remove must happen before re-registering (sync clears first, then adds)
      expect(mockRemoveJobScheduler.mock.invocationCallOrder[0]!).toBeLessThan(
        mockUpsertJobScheduler.mock.invocationCallOrder[0]!,
      );
    });

    it("only removes when the definition is no longer scheduled", async () => {
      await syncAgentDefinitionSchedule({
        id: "def-1",
        enabled: false,
        cronExpression: "0 9 * * *",
        runAt: null,
      });

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("agent-scheduled-def-1");
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });
  });

  describe("scheduleAllAgentDefinitions", () => {
    it("schedules every enabled definition with a cron expression", async () => {
      mockAgentDefinitionFindMany.mockResolvedValue([
        { id: "def-1", enabled: true, cronExpression: "0 15 * * *", runAt: null },
        { id: "def-2", enabled: true, cronExpression: "0 8 * * 1", runAt: null },
        { id: "def-3", enabled: false, cronExpression: "0 15 * * *", runAt: null },
      ]);

      await scheduleAllAgentDefinitions();

      expect(mockAgentDefinitionFindMany).toHaveBeenCalled();
      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "agent-scheduled-def-1",
        expect.objectContaining({ pattern: "0 15 * * *" }),
        expect.objectContaining({ name: "agent_execute", data: { definitionId: "def-1" } }),
      );
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "agent-scheduled-def-2",
        expect.objectContaining({ pattern: "0 8 * * 1" }),
        expect.objectContaining({ name: "agent_execute", data: { definitionId: "def-2" } }),
      );
    });

    it("restores a pending one-off runAt as a delayed job", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

      mockAgentDefinitionFindMany.mockResolvedValue([
        {
          id: "def-1",
          enabled: true,
          cronExpression: null,
          runAt: new Date("2026-01-01T02:00:00Z"),
        },
      ]);

      await scheduleAllAgentDefinitions();

      expect(mockAdd).toHaveBeenCalledWith(
        "agent_execute",
        { definitionId: "def-1" },
        expect.objectContaining({ jobId: "agent-once-def-1", delay: 2 * 60 * 60 * 1000 }),
      );
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });

    it("continues when one definition fails to schedule", async () => {
      mockAgentDefinitionFindMany.mockResolvedValue([
        { id: "def-1", enabled: true, cronExpression: "0 15 * * *", runAt: null },
        { id: "def-2", enabled: true, cronExpression: "0 8 * * 1", runAt: null },
      ]);

      mockRemoveJobScheduler.mockRejectedValueOnce(new Error("boom"));
      mockUpsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));

      await expect(scheduleAllAgentDefinitions()).resolves.toBeUndefined();

      // Second definition still scheduled despite first failing
      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(mockUpsertJobScheduler).toHaveBeenLastCalledWith(
        "agent-scheduled-def-2",
        expect.anything(),
        expect.objectContaining({ data: { definitionId: "def-2" } }),
      );
    });
  });
});
