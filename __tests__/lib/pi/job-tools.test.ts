import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    queueTask: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    taskRun: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn(),
    },
    emailAccount: {
      findMany: vi.fn(),
    },
  },
}));

// Mock queue
vi.mock("@/lib/queue", () => ({
  getQueue: vi.fn(),
  addJobRun: vi.fn(),
}));

// Mock buildModelRuntime
vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn(),
}));

// Import mocks for assertions
import * as db from "@/lib/db";
import * as queue from "@/lib/queue";
import * as models from "@/lib/pi/models";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueTask = db.prisma.queueTask as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAppSettings = db.prisma.appSettings as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueInstance: any = {
  add: vi.fn().mockResolvedValue({}),
  removeJobScheduler: vi.fn().mockResolvedValue(undefined),
};

// Import after mocks
import { createJobTools } from "@/lib/pi/tools/job-tools";

// Helper to call execute with all required args
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown>) =>
  execute("call-1", params, undefined, undefined, {} as never);

// Shared context for tool lookups
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx: any = {
  modelList: null,
  jobUpdate: null,
  jobDelete: null,
};

describe("createJobTools", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queue.getQueue).mockReturnValue(mockQueueInstance);

    const tools = createJobTools(userId);
    ctx.modelList = tools.find((t) => t.name === "model_list")!;
    ctx.jobUpdate = tools.find((t) => t.name === "job_update")!;
    ctx.jobDelete = tools.find((t) => t.name === "job_delete")!;
  });

  it("returns all expected tool names", () => {
    const tools = createJobTools(userId);
    const names = tools.map((t) => t.name);
    expect(names).toContain("job_list");
    expect(names).toContain("job_enable");
    expect(names).toContain("job_run");
    expect(names).toContain("job_logs");
    expect(names).toContain("job_types");
    expect(names).toContain("job_create");
    expect(names).toContain("model_list");
    expect(names).toContain("job_update");
    expect(names).toContain("job_delete");
  });

  describe("model_list", () => {
    it("returns models grouped by provider", async () => {
      vi.mocked(models.buildModelRuntime).mockResolvedValue({
        modelRuntime: {} as never,
        models: [
          { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
          { provider: "anthropic", id: "claude-opus-4-20250514", name: "Claude Opus 4" },
          { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        ],
      });

      vi.mocked(mockAppSettings.findUnique).mockResolvedValue({
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4-20250514",
        purposeModelOverrides: {
          jobs: { provider: "openai", model: "gpt-4o" },
        },
      });

      const result = await callExecute(ctx.modelList.execute, {});
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.count).toBe(3);
      expect(text.providers).toHaveLength(2);
      expect(text.providers[0].provider).toBe("anthropic");
      expect(text.providers[0].models).toHaveLength(2);
      expect(text.providers[1].provider).toBe("openai");
      expect(text.providers[1].models).toHaveLength(1);
      expect(text.defaults.user).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      });
      expect(text.defaults.jobs).toEqual({
        provider: "openai",
        model: "gpt-4o",
      });
    });

    it("returns null defaults when no settings exist", async () => {
      vi.mocked(models.buildModelRuntime).mockResolvedValue({
        modelRuntime: {} as never,
        models: [],
      });

      vi.mocked(mockAppSettings.findUnique).mockResolvedValue(null);

      const result = await callExecute(ctx.modelList.execute, {});
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.count).toBe(0);
      expect(text.providers).toHaveLength(0);
      expect(text.defaults.user).toBeNull();
      expect(text.defaults.jobs).toBeNull();
    });

    it("returns null for jobs default when no purpose override", async () => {
      vi.mocked(models.buildModelRuntime).mockResolvedValue({
        modelRuntime: {} as never,
        models: [],
      });

      vi.mocked(mockAppSettings.findUnique).mockResolvedValue({
        defaultModelProvider: "anthropic",
        defaultModelName: "claude-sonnet-4-20250514",
        purposeModelOverrides: null,
      });

      const result = await callExecute(ctx.modelList.execute, {});
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.defaults.user).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
      });
      expect(text.defaults.jobs).toBeNull();
    });
  });

  describe("job_update", () => {
    it("updates modelId on existing job", async () => {
      const existingJob = {
        id: "job-1",
        userId: "user-123",
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      };

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(existingJob);
      vi.mocked(mockQueueTask.update).mockResolvedValue({});

      const result = await callExecute(ctx.jobUpdate.execute, {
        id: "job-1",
        modelId: "anthropic:claude-sonnet-4-20250514",
      });

      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);
      expect(text.updated).toBe(true);
      expect(text.job.modelId).toBe("anthropic:claude-sonnet-4-20250514");

      expect(mockQueueTask.update).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: expect.objectContaining({ modelId: "anthropic:claude-sonnet-4-20250514" }),
      });

      // Scheduler should be removed and re-added
      expect(mockQueueInstance.removeJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockQueueInstance.add).toHaveBeenCalled();
    });

    it("updates cron expression and re-schedules", async () => {
      const existingJob = {
        id: "job-1",
        userId: "user-123",
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      };

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(existingJob);
      vi.mocked(mockQueueTask.update).mockResolvedValue({});

      await callExecute(ctx.jobUpdate.execute, {
        id: "job-1",
        config: { cronExpression: "*/30 * * * *" },
      });

      expect(mockQueueInstance.removeJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockQueueInstance.add).toHaveBeenCalledWith(
        "execute",
        expect.objectContaining({
          cronExpression: "*/30 * * * *",
          taskId: "job-1",
        }),
        expect.objectContaining({
          jobId: "scheduled-job-1",
          repeat: expect.objectContaining({ pattern: "*/30 * * * *" }),
        }),
      );
    });

    it("clears modelId when passed empty string", async () => {
      const existingJob = {
        id: "job-1",
        userId: "user-123",
        type: "summarization",
        enabled: true,
        modelId: "anthropic:claude-sonnet-4-20250514",
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      };

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(existingJob);
      vi.mocked(mockQueueTask.update).mockResolvedValue({});

      const result = await callExecute(ctx.jobUpdate.execute, {
        id: "job-1",
        modelId: "",
      });

      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);
      expect(text.job.modelId).toBeNull();
    });

    it("throws when job not found", async () => {
      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.jobUpdate.execute, {
          id: "nonexistent",
          modelId: "anthropic:claude-sonnet-4-20250514",
        }),
      ).rejects.toThrow("Job nonexistent not found");
    });

    it("throws when job belongs to another user", async () => {
      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(null);

      await expect(
        callExecute(ctx.jobUpdate.execute, {
          id: "other-user-job",
          modelId: "anthropic:claude-sonnet-4-20250514",
        }),
      ).rejects.toThrow("Job other-user-job not found");
    });

    it("does not re-schedule when job is disabled", async () => {
      const existingJob = {
        id: "job-1",
        userId: "user-123",
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      };

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(existingJob);
      vi.mocked(mockQueueTask.update).mockResolvedValue({});

      await callExecute(ctx.jobUpdate.execute, {
        id: "job-1",
        enabled: false,
      });

      expect(mockQueueInstance.removeJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      // Should NOT re-add scheduler when disabled
      expect(mockQueueInstance.add).not.toHaveBeenCalled();
    });
  });

  describe("job_delete", () => {
    it("deletes job and removes scheduler", async () => {
      const existingJob = {
        id: "job-1",
        userId: "user-123",
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      };

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(existingJob);
      vi.mocked(mockQueueTask.delete).mockResolvedValue({});

      const result = await callExecute(ctx.jobDelete.execute, { id: "job-1" });

      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);
      expect(text.deleted).toBe(true);
      expect(text.id).toBe("job-1");

      expect(mockQueueInstance.removeJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockQueueTask.delete).toHaveBeenCalledWith({ where: { id: "job-1" } });
    });

    it("throws when job not found", async () => {
      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(null);

      await expect(callExecute(ctx.jobDelete.execute, { id: "nonexistent" })).rejects.toThrow(
        "Job nonexistent not found",
      );
    });

    it("throws when job belongs to another user", async () => {
      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(null);

      await expect(callExecute(ctx.jobDelete.execute, { id: "other-user-job" })).rejects.toThrow(
        "Job other-user-job not found",
      );
    });

    it("handles scheduler removal failure gracefully", async () => {
      const existingJob = {
        id: "job-1",
        userId: "user-123",
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      };

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(existingJob);
      vi.mocked(mockQueueTask.delete).mockResolvedValue({});
      vi.mocked(mockQueueInstance.removeJobScheduler).mockRejectedValue(new Error("Redis error"));

      // Should still succeed — scheduler removal failure is logged, not thrown
      const result = await callExecute(ctx.jobDelete.execute, { id: "job-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);
      expect(text.deleted).toBe(true);
    });
  });
});
