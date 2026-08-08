import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    agentDefinition: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    agentRun: {
      create: vi.fn(),
      update: vi.fn(),
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

import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/lib/agent-jobs/executor";
import { buildAgentOutputHandler } from "@/lib/agent-jobs/output";
import { triggerAgentRun } from "@/lib/agent-jobs/run";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentDefinition = prisma.agentDefinition as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAgentRun = prisma.agentRun as any;

describe("triggerAgentRun", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeAgentRun).mockResolvedValue({
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
    });
  });

  it("creates a run, updates lastRunAt, and dispatches with the output handler", async () => {
    const definition = {
      id: "def-1",
      userId,
      prompt: "Daily briefing",
      systemPrompt: "System",
      toolConfig: { email: true },
      modelId: "anthropic:claude",
      thinkingLevel: "off",
      outputChannel: "telegram",
      outputChannelId: "12345",
      enabled: true,
    };

    mockAgentDefinition.findFirst.mockResolvedValue(definition);
    mockAgentRun.create.mockResolvedValue({
      id: "run-1",
      status: "pending",
      outputChannel: "telegram",
      outputChannelId: "12345",
      createdAt: new Date(),
    });
    mockAgentDefinition.update.mockResolvedValue({});

    const run = await triggerAgentRun({ definitionId: "def-1", userId });

    expect(mockAgentDefinition.findFirst).toHaveBeenCalledWith({
      where: { id: "def-1", userId },
    });
    expect(mockAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        definitionId: "def-1",
        userId,
        prompt: "Daily briefing",
        outputChannel: "telegram",
        outputChannelId: "12345",
      }),
    });
    expect(mockAgentDefinition.update).toHaveBeenCalledWith({
      where: { id: "def-1" },
      data: { lastRunAt: expect.any(Date) },
    });
    expect(buildAgentOutputHandler).toHaveBeenCalledWith({
      userId,
      outputChannel: "telegram",
      outputChannelId: "12345",
    });
    expect(executeAgentRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ prompt: "Daily briefing" }),
      userId,
      expect.objectContaining({ send: expect.any(Function) }),
    );
    expect(run.id).toBe("run-1");
  });

  it("marks the run completed with token stats on success", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue({
      id: "def-1",
      userId,
      prompt: "P",
      systemPrompt: null,
      toolConfig: null,
      modelId: null,
      thinkingLevel: "off",
      outputChannel: null,
      outputChannelId: null,
      enabled: true,
    });
    mockAgentRun.create.mockResolvedValue({
      id: "run-1",
      status: "pending",
      outputChannel: null,
      outputChannelId: null,
      createdAt: new Date(),
    });
    mockAgentDefinition.update.mockResolvedValue({});
    mockAgentRun.update.mockResolvedValue({});

    await triggerAgentRun({ definitionId: "def-1", userId });

    // Flush the fire-and-forget promise chain
    await vi.waitFor(() => {
      expect(mockAgentRun.update).toHaveBeenCalledWith({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "completed",
          inputTokens: 100,
          outputTokens: 50,
          cost: 0.001,
          completedAt: expect.any(Date),
        }),
      });
    });
  });

  it("marks the run as error when execution fails", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue({
      id: "def-1",
      userId,
      prompt: "P",
      systemPrompt: null,
      toolConfig: null,
      modelId: null,
      thinkingLevel: "off",
      outputChannel: null,
      outputChannelId: null,
      enabled: true,
    });
    mockAgentRun.create.mockResolvedValue({
      id: "run-1",
      status: "pending",
      outputChannel: null,
      outputChannelId: null,
      createdAt: new Date(),
    });
    mockAgentDefinition.update.mockResolvedValue({});
    mockAgentRun.update.mockResolvedValue({});

    vi.mocked(executeAgentRun).mockRejectedValue(new Error("model exploded"));

    await triggerAgentRun({ definitionId: "def-1", userId });

    await vi.waitFor(() => {
      expect(mockAgentRun.update).toHaveBeenCalledWith({
        where: { id: "run-1" },
        data: expect.objectContaining({
          status: "error",
          error: "model exploded",
          completedAt: expect.any(Date),
        }),
      });
    });
  });

  it("uses the prompt override when provided", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue({
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
    });
    mockAgentRun.create.mockResolvedValue({
      id: "run-1",
      status: "pending",
      outputChannel: null,
      outputChannelId: null,
      createdAt: new Date(),
    });
    mockAgentDefinition.update.mockResolvedValue({});

    const run = await triggerAgentRun({ definitionId: "def-1", userId, promptOverride: "Custom" });

    expect(mockAgentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ prompt: "Custom" }),
    });
    expect(run.prompt).toBe("Custom");
  });

  it("scopes the lookup to the user (no cross-user access)", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(null);

    await expect(triggerAgentRun({ definitionId: "def-1", userId })).rejects.toThrow(
      "Agent job def-1 not found",
    );
    expect(mockAgentRun.create).not.toHaveBeenCalled();
  });

  it("throws when the definition is disabled", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue({
      id: "def-1",
      userId,
      enabled: false,
    });

    await expect(triggerAgentRun({ definitionId: "def-1", userId })).rejects.toThrow(
      "Agent job def-1 is disabled",
    );
    expect(mockAgentRun.create).not.toHaveBeenCalled();
  });
});
