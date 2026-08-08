import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock prisma
vi.mock("@/lib/db", () => ({
  prisma: {
    agentDefinition: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    agentRun: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agentRunMessage: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/agent-jobs/executor", () => ({
  executeAgentRun: vi.fn().mockResolvedValue({ inputTokens: 100, outputTokens: 50, cost: 0.001 }),
}));

vi.mock("@/lib/agent-jobs/output", () => ({
  buildAgentOutputHandler: vi.fn().mockResolvedValue({
    send: vi.fn(),
    typing: vi.fn(),
  }),
}));

vi.mock("@/lib/queue", () => ({
  scheduleAgentDefinition: vi.fn().mockResolvedValue(undefined),
  unscheduleAgentDefinition: vi.fn().mockResolvedValue(undefined),
}));

// Import mocks for assertions
import * as db from "@/lib/db";
import * as queue from "@/lib/queue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentDefinition = db.prisma.agentDefinition as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentRun = db.prisma.agentRun as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentRunMessage = db.prisma.agentRunMessage as any;

import { createAgentJobTools } from "@/lib/pi/tools/agent-job-tools";
import { executeAgentRun } from "@/lib/agent-jobs/executor";
import { buildAgentOutputHandler } from "@/lib/agent-jobs/output";

// Helper to call execute with all required args
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callExecute = async (execute: any, params: Record<string, unknown>) =>
  execute("call-1", params, undefined, undefined, {} as never);

describe("createAgentJobTools", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all expected tool names", () => {
    const tools = createAgentJobTools(userId);
    const names = tools.map((t) => t.name);

    expect(names).toContain("agent_job_list");
    expect(names).toContain("agent_job_create");
    expect(names).toContain("agent_job_update");
    expect(names).toContain("agent_job_delete");
    expect(names).toContain("agent_job_run");
    expect(names).toContain("agent_job_logs");
    expect(names).toContain("agent_job_run_messages");
  });

  describe("agent_job_list", () => {
    const tools = createAgentJobTools(userId);
    const tool = tools.find((t) => t.name === "agent_job_list")!;

    it("returns all definitions with output channel fields", async () => {
      mockAgentDefinition.findMany.mockResolvedValue([
        {
          id: "def-1",
          name: "Email Summary",
          description: "Summarizes emails",
          prompt: "Summarize my emails",
          systemPrompt: null,
          toolConfig: { email: true },
          modelId: "anthropic:claude-sonnet-4",
          outputChannel: "telegram",
          outputChannelId: "12345",
          cronExpression: "0 9 * * *",
          lastRunAt: new Date("2024-01-01T09:00:00Z"),
          enabled: true,
          _count: { runs: 5 },
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);

      const result = await callExecute(tool.execute, {});
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.count).toBe(1);
      expect(text.jobs[0].outputChannel).toBe("telegram");
      expect(text.jobs[0].outputChannelId).toBe("12345");
      expect(text.jobs[0].cronExpression).toBe("0 9 * * *");
      expect(text.jobs[0].lastRunAt).toBe("2024-01-01T09:00:00.000Z");
      expect(text.jobs[0].runCount).toBe(5);
    });

    it("filters by enabled status", async () => {
      mockAgentDefinition.findMany.mockResolvedValue([]);

      await callExecute(tool.execute, { enabled: true });

      const callArgs = (mockAgentDefinition.findMany as Mock).mock.calls[0]!;
      expect(callArgs[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ userId, enabled: true }),
          orderBy: { createdAt: "desc" },
        }),
      );
    });
  });

  describe("agent_job_create", () => {
    const tools = createAgentJobTools(userId);
    const tool = tools.find((t) => t.name === "agent_job_create")!;

    it("creates definition with output channel fields", async () => {
      const createdDef = {
        id: "def-new",
        name: "Daily Report",
        description: "Daily status report",
        prompt: "Generate daily report",
        systemPrompt: "You are a reporting assistant",
        toolConfig: { email: true, calendar: true },
        modelId: "anthropic:claude-sonnet-4",
        outputChannel: "telegram",
        outputChannelId: "54321",
        cronExpression: "0 18 * * *",
        enabled: true,
        createdAt: new Date("2024-01-01T00:00:00Z"),
      };

      mockAgentDefinition.create.mockResolvedValue(createdDef);

      const result = await callExecute(tool.execute, {
        name: "Daily Report",
        prompt: "Generate daily report",
        description: "Daily status report",
        systemPrompt: "You are a reporting assistant",
        toolConfig: { email: true, calendar: true },
        modelId: "anthropic:claude-sonnet-4",
        outputChannel: "telegram",
        outputChannelId: "54321",
        cronExpression: "0 18 * * *",
      });

      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);
      expect(text.created).toBe(true);
      expect(text.job.outputChannel).toBe("telegram");
      expect(text.job.outputChannelId).toBe("54321");
      expect(text.job.cronExpression).toBe("0 18 * * *");

      expect(mockAgentDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId,
          name: "Daily Report",
          outputChannel: "telegram",
          outputChannelId: "54321",
          cronExpression: "0 18 * * *",
        }),
      });

      // Definition with a cron expression must be registered as a repeatable job
      expect(queue.scheduleAgentDefinition).toHaveBeenCalledWith(createdDef);
    });

    it("normalizes modelId with / separator to :", async () => {
      mockAgentDefinition.create.mockResolvedValue({
        id: "def-new",
        name: "Test Job",
        prompt: "Test",
        modelId: "anthropic:claude-sonnet-4",
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        enabled: true,
        createdAt: new Date(),
      });

      await callExecute(tool.execute, {
        name: "Test Job",
        prompt: "Test",
        modelId: "anthropic/claude-sonnet-4",
      });

      expect(mockAgentDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          modelId: "anthropic:claude-sonnet-4",
        }),
      });
    });

    it("handles null output channel and cron", async () => {
      mockAgentDefinition.create.mockResolvedValue({
        id: "def-new",
        name: "Simple Job",
        prompt: "Do something",
        modelId: null,
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        enabled: true,
        createdAt: new Date(),
      });

      await callExecute(tool.execute, {
        name: "Simple Job",
        prompt: "Do something",
      });

      expect(mockAgentDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          outputChannel: null,
          outputChannelId: null,
          cronExpression: null,
        }),
      });

      // No cron → no repeatable job should be registered
      expect(queue.scheduleAgentDefinition).not.toHaveBeenCalled();
    });

    it("trims string fields", async () => {
      mockAgentDefinition.create.mockResolvedValue({
        id: "def-new",
        name: "  Trimmed  ",
        prompt: "  Prompt  ",
        modelId: null,
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        enabled: true,
        createdAt: new Date(),
      });

      await callExecute(tool.execute, {
        name: "  Trimmed  ",
        prompt: "  Prompt  ",
        description: "  Description  ",
        systemPrompt: "  System  ",
      });

      expect(mockAgentDefinition.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: "Trimmed",
          prompt: "Prompt",
          description: "Description",
          systemPrompt: "System",
        }),
      });
    });
  });

  describe("agent_job_update", () => {
    const tools = createAgentJobTools(userId);
    const tool = tools.find((t) => t.name === "agent_job_update")!;

    it("updates output channel fields", async () => {
      const existingDef = {
        id: "def-1",
        userId,
        name: "Old Name",
        enabled: true,
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        updatedAt: new Date("2024-01-02T00:00:00Z"),
      };

      const updatedDef = {
        ...existingDef,
        outputChannel: "telegram",
        outputChannelId: "99999",
        cronExpression: "0 9 * * 1",
        updatedAt: new Date("2024-01-02T00:00:00Z"),
      };

      mockAgentDefinition.findFirst.mockResolvedValue(existingDef);
      mockAgentDefinition.update.mockResolvedValue(updatedDef);

      await callExecute(tool.execute, {
        id: "def-1",
        outputChannel: "telegram",
        outputChannelId: "99999",
        cronExpression: "0 9 * * 1",
      });

      expect(mockAgentDefinition.update).toHaveBeenCalledWith({
        where: { id: "def-1" },
        data: expect.objectContaining({
          outputChannel: "telegram",
          outputChannelId: "99999",
          cronExpression: "0 9 * * 1",
        }),
      });

      // Schedule must be resynced: remove old scheduler, re-add with new cron
      expect(queue.unscheduleAgentDefinition).toHaveBeenCalledWith("def-1");
      expect(queue.scheduleAgentDefinition).toHaveBeenCalledWith(updatedDef);
    });

    it("clears fields when passed empty string", async () => {
      const existingDef = {
        id: "def-1",
        userId,
        enabled: true,
        outputChannel: "telegram",
        outputChannelId: "123",
        cronExpression: "0 9 * * *",
        modelId: "anthropic:claude",
        updatedAt: new Date(),
      };

      mockAgentDefinition.findFirst.mockResolvedValue(existingDef);
      mockAgentDefinition.update.mockResolvedValue({
        ...existingDef,
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        modelId: null,
      });

      await callExecute(tool.execute, {
        id: "def-1",
        outputChannel: "",
        outputChannelId: "",
        cronExpression: "",
        modelId: "",
      });

      expect(mockAgentDefinition.update).toHaveBeenCalledWith({
        where: { id: "def-1" },
        data: expect.objectContaining({
          outputChannel: null,
          outputChannelId: null,
          cronExpression: null,
          modelId: null,
        }),
      });

      // Cron cleared → scheduler removed, nothing re-added
      expect(queue.unscheduleAgentDefinition).toHaveBeenCalledWith("def-1");
      expect(queue.scheduleAgentDefinition).not.toHaveBeenCalled();
    });

    it("throws when job not found", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue(null);

      await expect(
        callExecute(tool.execute, {
          id: "nonexistent",
          outputChannel: "telegram",
        }),
      ).rejects.toThrow("Agent job nonexistent not found");
    });

    it("only updates provided fields", async () => {
      const existingDef = {
        id: "def-1",
        userId,
        name: "Old Name",
        prompt: "Old Prompt",
        outputChannel: null,
        outputChannelId: null,
        cronExpression: null,
        updatedAt: new Date(),
      };

      mockAgentDefinition.findFirst.mockResolvedValue(existingDef);
      mockAgentDefinition.update.mockResolvedValue({
        ...existingDef,
        name: "New Name",
      });

      await callExecute(tool.execute, {
        id: "def-1",
        name: "New Name",
        // prompt, outputChannel, etc. not provided
      });

      expect(mockAgentDefinition.update).toHaveBeenCalledWith({
        where: { id: "def-1" },
        data: { name: "New Name" },
      });
    });
  });

  describe("agent_job_delete", () => {
    const tools = createAgentJobTools(userId);
    const tool = tools.find((t) => t.name === "agent_job_delete")!;

    it("deletes definition", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue({ id: "def-1", userId });
      mockAgentDefinition.delete.mockResolvedValue({});

      const result = await callExecute(tool.execute, { id: "def-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.deleted).toBe(true);
      expect(text.id).toBe("def-1");
      expect(mockAgentDefinition.delete).toHaveBeenCalledWith({ where: { id: "def-1" } });

      // Deleting must remove the repeatable job so it stops firing
      expect(queue.unscheduleAgentDefinition).toHaveBeenCalledWith("def-1");
    });

    it("throws when job not found", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue(null);

      await expect(callExecute(tool.execute, { id: "nonexistent" })).rejects.toThrow(
        "Agent job nonexistent not found",
      );
    });
  });

  describe("agent_job_run", () => {
    const tools = createAgentJobTools(userId);
    const tool = tools.find((t) => t.name === "agent_job_run")!;

    it("passes the telegram output handler to executeAgentRun", async () => {
      const def = {
        id: "def-1",
        userId,
        prompt: "Default prompt",
        systemPrompt: "System",
        toolConfig: { email: true },
        modelId: "anthropic:claude",
        thinkingLevel: "off",
        outputChannel: "telegram",
        outputChannelId: "12345",
        enabled: true,
      };

      mockAgentDefinition.findFirst.mockResolvedValue(def);
      mockAgentRun.create.mockResolvedValue({ id: "run-1" });
      mockAgentDefinition.update.mockResolvedValue({});

      await callExecute(tool.execute, { id: "def-1" });

      expect(buildAgentOutputHandler).toHaveBeenCalledWith({
        userId,
        outputChannel: "telegram",
        outputChannelId: "12345",
      });
      expect(executeAgentRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ prompt: "Default prompt" }),
        userId,
        expect.objectContaining({ send: expect.any(Function) }),
      );
    });

    it("passes undefined output handler when definition has no channel", async () => {
      (buildAgentOutputHandler as unknown as Mock).mockResolvedValueOnce(undefined);

      const def = {
        id: "def-1",
        userId,
        prompt: "Default prompt",
        systemPrompt: null,
        toolConfig: null,
        modelId: null,
        thinkingLevel: "off",
        outputChannel: null,
        outputChannelId: null,
        enabled: true,
      };

      mockAgentDefinition.findFirst.mockResolvedValue(def);
      mockAgentRun.create.mockResolvedValue({ id: "run-1" });
      mockAgentDefinition.update.mockResolvedValue({});

      await callExecute(tool.execute, { id: "def-1" });

      expect(buildAgentOutputHandler).toHaveBeenCalledWith({
        userId,
        outputChannel: null,
        outputChannelId: null,
      });
      expect(executeAgentRun).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({ prompt: "Default prompt" }),
        userId,
        undefined,
      );
    });

    it("creates run with output channel from definition", async () => {
      const def = {
        id: "def-1",
        userId,
        prompt: "Default prompt",
        systemPrompt: "System",
        toolConfig: { email: true },
        modelId: "anthropic:claude",
        thinkingLevel: "off",
        outputChannel: "telegram",
        outputChannelId: "12345",
        enabled: true,
      };

      const run = { id: "run-1", definitionId: "def-1", userId, status: "pending" };

      mockAgentDefinition.findFirst.mockResolvedValue(def);
      mockAgentRun.create.mockResolvedValue(run);
      mockAgentDefinition.update.mockResolvedValue({});

      const result = await callExecute(tool.execute, { id: "def-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.queued).toBe(true);
      expect(text.runId).toBe("run-1");

      expect(mockAgentRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          definitionId: "def-1",
          userId,
          outputChannel: "telegram",
          outputChannelId: "12345",
        }),
      });
    });

    it("uses prompt override when provided", async () => {
      const def = {
        id: "def-1",
        userId,
        prompt: "Default prompt",
        systemPrompt: null,
        toolConfig: null,
        modelId: null,
        thinkingLevel: "off",
        outputChannel: null,
        outputChannelId: null,
        enabled: true,
      };

      mockAgentDefinition.findFirst.mockResolvedValue(def);
      mockAgentRun.create.mockResolvedValue({ id: "run-1" });
      mockAgentDefinition.update.mockResolvedValue({});

      await callExecute(tool.execute, {
        id: "def-1",
        prompt: "Override prompt",
      });

      expect(mockAgentRun.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          prompt: "Override prompt",
        }),
      });
    });

    it("throws when job is disabled", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue({
        id: "def-1",
        userId,
        enabled: false,
      });

      await expect(callExecute(tool.execute, { id: "def-1" })).rejects.toThrow(
        "Agent job def-1 is disabled",
      );
    });
  });

  describe("agent_job_logs", () => {
    const tools = createAgentJobTools(userId);
    const tool = tools.find((t) => t.name === "agent_job_logs")!;

    it("returns runs with duration calculation", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue({ id: "def-1" });
      mockAgentRun.findMany.mockResolvedValue([
        {
          id: "run-1",
          status: "completed",
          prompt: "Test",
          modelId: "anthropic:claude",
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.001,
          error: null,
          startedAt: new Date("2024-01-01T00:00:00Z"),
          completedAt: new Date("2024-01-01T00:05:00Z"),
          createdAt: new Date("2024-01-01T00:00:00Z"),
        },
      ]);

      const result = await callExecute(tool.execute, { id: "def-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.count).toBe(1);
      expect(text.runs[0].duration).toBe(5 * 60 * 1000); // 5 minutes in ms
    });

    it("returns null duration when timestamps missing", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue({ id: "def-1" });
      mockAgentRun.findMany.mockResolvedValue([
        {
          id: "run-1",
          status: "pending",
          prompt: "Test",
          modelId: null,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          error: null,
          startedAt: null,
          completedAt: null,
          createdAt: new Date(),
        },
      ]);

      const result = await callExecute(tool.execute, { id: "def-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.runs[0].duration).toBeNull();
    });

    it("filters by status", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue({ id: "def-1" });
      mockAgentRun.findMany.mockResolvedValue([]);

      await callExecute(tool.execute, { id: "def-1", status: "error" });

      // Verify the call included status filter
      const callArgs = (mockAgentRun.findMany as Mock).mock.calls[0]!;
      expect(callArgs[0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ status: "error" }),
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
      );
    });

    it("limits results to specified count", async () => {
      mockAgentDefinition.findFirst.mockResolvedValue({ id: "def-1" });
      mockAgentRun.findMany.mockResolvedValue([]);

      await callExecute(tool.execute, { id: "def-1", limit: 5 });

      // Verify the call included take: 5
      const callArgs = (mockAgentRun.findMany as Mock).mock.calls[0]!;
      expect(callArgs[0]).toEqual(expect.objectContaining({ take: 5 }));
    });
  });

  describe("agent_job_run_messages", () => {
    const tools = createAgentJobTools(userId);
    const tool = tools.find((t) => t.name === "agent_job_run_messages")!;

    it("parses toolCalls JSON from database", async () => {
      mockAgentRun.findFirst.mockResolvedValue({ id: "run-1" });
      mockAgentRunMessage.findMany.mockResolvedValue([
        {
          id: "msg-1",
          role: "assistant",
          content: "Hello",
          thinking: null,
          toolCalls:
            '[{"id":"tc1","name":"email_search","args":{"query":"unread"},"result":"Found 3","isError":false}]',
          createdAt: new Date(),
        },
      ]);

      const result = await callExecute(tool.execute, { runId: "run-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.messages[0].toolCalls).toEqual([
        {
          id: "tc1",
          name: "email_search",
          args: { query: "unread" },
          result: "Found 3",
          isError: false,
        },
      ]);
    });

    it("handles null toolCalls", async () => {
      mockAgentRun.findFirst.mockResolvedValue({ id: "run-1" });
      mockAgentRunMessage.findMany.mockResolvedValue([
        {
          id: "msg-1",
          role: "user",
          content: "Hello",
          thinking: null,
          toolCalls: null,
          createdAt: new Date(),
        },
      ]);

      const result = await callExecute(tool.execute, { runId: "run-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.messages[0].toolCalls).toBeNull();
    });

    it("orders messages chronologically", async () => {
      mockAgentRun.findFirst.mockResolvedValue({ id: "run-1" });
      mockAgentRunMessage.findMany.mockResolvedValue([
        { id: "msg-1", role: "user", content: "Hi", createdAt: new Date("2024-01-01T00:00:00Z") },
        {
          id: "msg-2",
          role: "assistant",
          content: "Hello!",
          createdAt: new Date("2024-01-01T00:01:00Z"),
        },
      ]);

      const result = await callExecute(tool.execute, { runId: "run-1" });
      const text = JSON.parse((result.content[0] as { type: string; text: string }).text);

      expect(text.messages[0].id).toBe("msg-1");
      expect(text.messages[1].id).toBe("msg-2");
    });
  });
});
