import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock queue instance — `getQueue()` must return the same instance
// every call so assertions can observe `add`/`upsertJobScheduler`.
const { mockAdd, mockRemoveJobScheduler, mockUpsertJobScheduler, mockGetJobSchedulers } =
  vi.hoisted(() => ({
    mockAdd: vi.fn(),
    mockRemoveJobScheduler: vi.fn(),
    mockUpsertJobScheduler: vi.fn(),
    mockGetJobSchedulers: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    queueTask: {
      findMany: vi.fn(),
    },
    taskRun: {
      create: vi.fn(),
    },
  },
}));

// Mock the queue instance (no real Redis in tests)
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
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
  queueTaskSchedulerId,
  scheduleQueueTask,
  unscheduleQueueTask,
  syncQueueTaskSchedule,
  triggerQueueTaskRun,
  scheduleAllJobs,
} from "@/lib/queue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueTaskFindMany = vi.mocked(prisma.queueTask.findMany as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTaskRunCreate = vi.mocked(prisma.taskRun.create as any);

const scheduledJob = {
  id: "job-1",
  type: "summarization",
  enabled: true,
  modelId: "anthropic:claude-sonnet",
  config: JSON.stringify({ cronExpression: "0 15 * * *", accountId: "acc-1" }),
};

describe("QueueTask scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdd.mockResolvedValue({});
    mockRemoveJobScheduler.mockResolvedValue(undefined);
    mockUpsertJobScheduler.mockResolvedValue({});
    mockGetJobSchedulers.mockResolvedValue([]);
    mockTaskRunCreate.mockResolvedValue({ id: "run-1" });
  });

  describe("queueTaskSchedulerId", () => {
    it("produces the canonical scheduler key", () => {
      expect(queueTaskSchedulerId("job-1")).toBe("scheduled-job-1");
    });
  });

  describe("scheduleQueueTask", () => {
    it("registers an execute job scheduler with cron pattern, config and model", async () => {
      await scheduleQueueTask(scheduledJob);

      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "scheduled-job-1",
        { pattern: "0 15 * * *", tz: "UTC" },
        {
          name: "execute",
          data: {
            cronExpression: "0 15 * * *",
            accountId: "acc-1",
            taskId: "job-1",
            type: "summarization",
            modelId: "anthropic:claude-sonnet",
          },
        },
      );
    });

    it("does nothing when the job is disabled", async () => {
      await scheduleQueueTask({ ...scheduledJob, enabled: false });
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });

    it("does nothing when the config has no cron expression", async () => {
      await scheduleQueueTask({
        ...scheduledJob,
        config: JSON.stringify({ accountId: "acc-1" }),
      });
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });
  });

  describe("unscheduleQueueTask", () => {
    it("removes the repeatable scheduler", async () => {
      await unscheduleQueueTask("job-1");
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
    });

    it("swallows errors from removeJobScheduler (scheduler may not exist)", async () => {
      mockRemoveJobScheduler.mockRejectedValue(new Error("not found"));
      await expect(unscheduleQueueTask("job-1")).resolves.toBeUndefined();
    });
  });

  describe("syncQueueTaskSchedule", () => {
    it("removes the old scheduler then re-adds when scheduled", async () => {
      await syncQueueTaskSchedule(scheduledJob);

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "scheduled-job-1",
        expect.objectContaining({ pattern: "0 15 * * *" }),
        expect.objectContaining({
          name: "execute",
          data: expect.objectContaining({ taskId: "job-1" }),
        }),
      );
      expect(mockRemoveJobScheduler.mock.invocationCallOrder[0]!).toBeLessThan(
        mockUpsertJobScheduler.mock.invocationCallOrder[0]!,
      );
    });

    it("only removes when the job is no longer scheduled", async () => {
      await syncQueueTaskSchedule({ ...scheduledJob, enabled: false });

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });
  });

  describe("triggerQueueTaskRun", () => {
    it("records a TaskRun and enqueues a one-off job with the runId", async () => {
      const { runId } = await triggerQueueTaskRun(scheduledJob);

      expect(runId).toBe("run-1");
      expect(mockTaskRunCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: "job-1",
          status: "pending",
          input: scheduledJob.config,
        }),
      });
      expect(mockAdd).toHaveBeenCalledWith(
        "execute",
        expect.objectContaining({ taskId: "job-1", runId: "run-1" }),
        expect.objectContaining({
          jobId: expect.stringMatching(/^manual-job-1-\d+$/),
          removeOnComplete: false,
          removeOnFail: 100,
        }),
      );
    });
  });

  describe("scheduleAllJobs", () => {
    it("schedules every enabled job with a cron expression", async () => {
      mockQueueTaskFindMany.mockResolvedValue([
        {
          id: "job-1",
          type: "summarization",
          enabled: true,
          modelId: null,
          config: '{"cronExpression":"0 15 * * *"}',
        },
        {
          id: "job-2",
          type: "classification",
          enabled: true,
          modelId: null,
          config: '{"cronExpression":"0 8 * * 1"}',
        },
        {
          id: "job-3",
          type: "email_sync",
          enabled: false,
          modelId: null,
          config: '{"cronExpression":"*/30 * * * *"}',
        },
      ]);

      await scheduleAllJobs();

      expect(mockQueueTaskFindMany).toHaveBeenCalled();
      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "scheduled-job-1",
        expect.objectContaining({ pattern: "0 15 * * *" }),
        expect.objectContaining({
          name: "execute",
          data: expect.objectContaining({ taskId: "job-1" }),
        }),
      );
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        "scheduled-job-2",
        expect.objectContaining({ pattern: "0 8 * * 1" }),
        expect.objectContaining({
          name: "execute",
          data: expect.objectContaining({ taskId: "job-2" }),
        }),
      );
    });

    it("continues when one job fails to schedule", async () => {
      mockQueueTaskFindMany.mockResolvedValue([
        {
          id: "job-1",
          type: "summarization",
          enabled: true,
          modelId: null,
          config: '{"cronExpression":"0 15 * * *"}',
        },
        {
          id: "job-2",
          type: "classification",
          enabled: true,
          modelId: null,
          config: '{"cronExpression":"0 8 * * 1"}',
        },
      ]);

      mockUpsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));

      await expect(scheduleAllJobs()).resolves.toBeUndefined();

      // Second job still scheduled despite first failing
      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(2);
      expect(mockUpsertJobScheduler).toHaveBeenLastCalledWith(
        "scheduled-job-2",
        expect.anything(),
        expect.objectContaining({ data: expect.objectContaining({ taskId: "job-2" }) }),
      );
    });
  });
});
