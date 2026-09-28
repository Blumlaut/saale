import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock queue instance — the real scheduling helpers in @/lib/queue
// call `new Queue(...)`, so the mock must return the same instance every time.
const { mockAdd, mockRemoveJobScheduler } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockRemoveJobScheduler: vi.fn(),
}));

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

// Mock the queue instance (no real Redis in tests)
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return { add: mockAdd, removeJobScheduler: mockRemoveJobScheduler };
  }),
}));

// Mock buildModelRuntime
vi.mock("@/lib/pi/models", () => ({
  buildModelRuntime: vi.fn(),
}));

// Import mocks for assertions
import * as db from "@/lib/db";
import * as models from "@/lib/pi/models";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQueueTask = db.prisma.queueTask as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockTaskRun = db.prisma.taskRun as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAppSettings = db.prisma.appSettings as any;

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
    mockAdd.mockResolvedValue({});
    mockRemoveJobScheduler.mockResolvedValue(undefined);
    mockTaskRun.create.mockResolvedValue({ id: "run-1" });

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
          {
            provider: "anthropic",
            id: "claude-sonnet-4-20250514",
            name: "Claude Sonnet 4",
            vision: true,
          },
          {
            provider: "anthropic",
            id: "claude-opus-4-20250514",
            name: "Claude Opus 4",
            vision: true,
          },
          { provider: "openai", id: "gpt-4o", name: "GPT-4o", vision: true },
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

  describe("job_create", () => {
    it("creates the job and registers a repeatable scheduler", async () => {
      const tools = createJobTools(userId);
      const jobCreate = tools.find((t) => t.name === "job_create")!;

      vi.mocked(mockQueueTask.create).mockResolvedValue({
        id: "job-new",
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
        createdAt: new Date(),
      });

      const result = await callExecute(jobCreate.execute, {
        type: "summarization",
        config: { cronExpression: "0 */6 * * *" },
      });

      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);
      expect(text.created).toBe(true);

      expect(mockAdd).toHaveBeenCalledWith(
        "execute",
        expect.objectContaining({
          cronExpression: "0 */6 * * *",
          taskId: "job-new",
          type: "summarization",
        }),
        expect.objectContaining({
          jobId: "scheduled-job-new",
          repeat: expect.objectContaining({
            pattern: "0 */6 * * *",
            tz: "UTC",
            key: "scheduled-job-new",
          }),
        }),
      );
    });

    it("does not schedule when disabled", async () => {
      const tools = createJobTools(userId);
      const jobCreate = tools.find((t) => t.name === "job_create")!;

      vi.mocked(mockQueueTask.create).mockResolvedValue({
        id: "job-new",
        type: "summarization",
        enabled: false,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
        createdAt: new Date(),
      });

      await callExecute(jobCreate.execute, {
        type: "summarization",
        config: { cronExpression: "0 */6 * * *" },
        enabled: false,
      });

      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("rejects unknown job types", async () => {
      const tools = createJobTools(userId);
      const jobCreate = tools.find((t) => t.name === "job_create")!;

      await expect(
        callExecute(jobCreate.execute, {
          type: "nonexistent_type",
          config: { cronExpression: "0 * * * *" },
        }),
      ).rejects.toThrow('Unknown job type "nonexistent_type"');
    });
  });

  describe("job_enable", () => {
    it("re-schedules when enabling a job with a cron", async () => {
      const tools = createJobTools(userId);
      const jobEnable = tools.find((t) => t.name === "job_enable")!;

      const existingJob = {
        id: "job-1",
        userId,
        type: "summarization",
        enabled: false,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      };
      vi.mocked(mockQueueTask.findFirst).mockResolvedValue(existingJob);
      vi.mocked(mockQueueTask.update).mockResolvedValue({});

      await callExecute(jobEnable.execute, { id: "job-1", enabled: true });

      expect(mockQueueTask.update).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: { enabled: true },
      });
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockAdd).toHaveBeenCalledWith(
        "execute",
        expect.objectContaining({ taskId: "job-1" }),
        expect.objectContaining({ jobId: "scheduled-job-1" }),
      );
    });

    it("removes the scheduler when disabling", async () => {
      const tools = createJobTools(userId);
      const jobEnable = tools.find((t) => t.name === "job_enable")!;

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue({
        id: "job-1",
        userId,
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      });
      vi.mocked(mockQueueTask.update).mockResolvedValue({});

      await callExecute(jobEnable.execute, { id: "job-1", enabled: false });

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockAdd).not.toHaveBeenCalled();
    });
  });

  describe("job_run", () => {
    it("records a run and enqueues a one-off job", async () => {
      const tools = createJobTools(userId);
      const jobRun = tools.find((t) => t.name === "job_run")!;

      vi.mocked(mockQueueTask.findFirst).mockResolvedValue({
        id: "job-1",
        userId,
        type: "summarization",
        enabled: true,
        modelId: null,
        config: JSON.stringify({ cronExpression: "0 */6 * * *" }),
      });

      const result = await callExecute(jobRun.execute, { id: "job-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.queued).toBe(true);
      expect(text.runId).toBe("run-1");
      expect(mockTaskRun.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ taskId: "job-1" }) }),
      );
      expect(mockAdd).toHaveBeenCalledWith(
        "execute",
        expect.objectContaining({ taskId: "job-1", runId: "run-1" }),
        expect.objectContaining({
          jobId: expect.stringMatching(/^manual-job-1-\d+$/),
          removeOnComplete: false,
        }),
      );
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
      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockAdd).toHaveBeenCalled();
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

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      expect(mockAdd).toHaveBeenCalledWith(
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

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
      // Should NOT re-add scheduler when disabled
      expect(mockAdd).not.toHaveBeenCalled();
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

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith("scheduled-job-1");
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
      mockRemoveJobScheduler.mockRejectedValue(new Error("Redis error"));

      // Should still succeed — scheduler removal failure is logged, not thrown
      const result = await callExecute(ctx.jobDelete.execute, { id: "job-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);
      expect(text.deleted).toBe(true);
    });
  });
});
