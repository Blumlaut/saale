import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock queue instance — `getQueue()` must return the same instance
// every call so assertions can observe `upsertJobScheduler`.
const { mockAdd, mockRemoveJobScheduler, mockUpsertJobScheduler, mockGetJobSchedulers } =
  vi.hoisted(() => ({
    mockAdd: vi.fn(),
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
      removeJobScheduler: mockRemoveJobScheduler,
      upsertJobScheduler: mockUpsertJobScheduler,
      getJobSchedulers: mockGetJobSchedulers,
    };
  }),
}));

import { prisma } from "@/lib/db";
import {
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
    mockRemoveJobScheduler.mockResolvedValue(undefined);
    mockUpsertJobScheduler.mockResolvedValue({});
    mockGetJobSchedulers.mockResolvedValue([]);
  });

  describe("agentSchedulerId", () => {
    it("namespaces agent schedulers separately from QueueTask schedulers", () => {
      expect(agentSchedulerId("def-1")).toBe("agent-scheduled-def-1");
      expect(agentSchedulerId("def-1")).not.toBe("scheduled-def-1");
    });
  });

  describe("scheduleAgentDefinition", () => {
    it("registers an agent_execute job scheduler with the cron pattern", async () => {
      await scheduleAgentDefinition({
        id: "def-1",
        enabled: true,
        cronExpression: "0 15 * * *",
      });

      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "agent-scheduled-def-1",
        { pattern: "0 15 * * *", tz: "UTC" },
        { name: "agent_execute", data: { definitionId: "def-1" } },
      );
    });

    it("does nothing when the definition has no cron expression", async () => {
      await scheduleAgentDefinition({ id: "def-1", enabled: true, cronExpression: null });
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });

    it("does nothing when the definition is disabled", async () => {
      await scheduleAgentDefinition({
        id: "def-1",
        enabled: false,
        cronExpression: "0 15 * * *",
      });
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });
  });

  describe("unscheduleAgentDefinition", () => {
    it("removes the repeatable scheduler", async () => {
      await unscheduleAgentDefinition("def-1");
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("agent-scheduled-def-1");
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
      });

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("agent-scheduled-def-1");
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });
  });

  describe("scheduleAllAgentDefinitions", () => {
    it("schedules every enabled definition with a cron expression", async () => {
      mockAgentDefinitionFindMany.mockResolvedValue([
        { id: "def-1", enabled: true, cronExpression: "0 15 * * *" },
        { id: "def-2", enabled: true, cronExpression: "0 8 * * 1" },
        { id: "def-3", enabled: false, cronExpression: "0 15 * * *" },
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

    it("continues when one definition fails to schedule", async () => {
      mockAgentDefinitionFindMany.mockResolvedValue([
        { id: "def-1", enabled: true, cronExpression: "0 15 * * *" },
        { id: "def-2", enabled: true, cronExpression: "0 8 * * 1" },
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
