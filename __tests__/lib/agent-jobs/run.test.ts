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
    output: {
      send: vi.fn(),
      typing: vi.fn(),
    },
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

// ─── Output delivery ─────────────────────────────────────────────────────────

/** A telegram-output definition, as the lookup returns it. */
const telegramDefinition = {
  id: "def-1",
  userId: "user-123",
  prompt: "Daily briefing",
  systemPrompt: null,
  toolConfig: null,
  modelId: null,
  thinkingLevel: "off",
  outputChannel: "telegram",
  outputChannelId: null,
  enabled: true,
};

/** A definition that routes output nowhere. */
const channelLessDefinition = {
  ...telegramDefinition,
  outputChannel: null,
  outputChannelId: null,
};

const pendingRun = {
  id: "run-1",
  status: "pending",
  outputChannel: "telegram",
  outputChannelId: null,
  createdAt: new Date(),
};

describe("triggerAgentRun output delivery", () => {
  const userId = "user-123";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executeAgentRun).mockResolvedValue({
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
    });
    mockAgentDefinition.update.mockResolvedValue({});
    mockAgentRun.update.mockResolvedValue({});
  });

  it("records a channel that could not be resolved, so the run is not read as delivered", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(telegramDefinition);
    mockAgentRun.create.mockResolvedValue(pendingRun);
    vi.mocked(buildAgentOutputHandler).mockResolvedValue({
      error: "Telegram output is configured but no Telegram bot is connected.",
    });

    await triggerAgentRun({ definitionId: "def-1", userId });

    expect(mockAgentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: "running",
        deliveryError: "Telegram output is configured but no Telegram bot is connected.",
      }),
    });
    // The agent still runs — the messages are worth keeping either way.
    expect(executeAgentRun).toHaveBeenCalledWith("run-1", expect.anything(), userId, undefined);
  });

  it("records delivery failures the handler collected during the run", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(telegramDefinition);
    mockAgentRun.create.mockResolvedValue(pendingRun);
    vi.mocked(buildAgentOutputHandler).mockResolvedValue({
      output: {
        send: vi.fn(),
        deliveryErrors: () => ["chat not found", "chat not found", "rate limited"],
      },
    });

    await triggerAgentRun({ definitionId: "def-1", userId });

    await vi.waitFor(() => {
      expect(mockAgentRun.update).toHaveBeenCalledWith({
        where: { id: "run-1" },
        data: { deliveryError: "chat not found\nrate limited" },
      });
    });
  });

  it("records failures even when the run itself errored", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(telegramDefinition);
    mockAgentRun.create.mockResolvedValue(pendingRun);
    vi.mocked(executeAgentRun).mockRejectedValue(new Error("model exploded"));
    vi.mocked(buildAgentOutputHandler).mockResolvedValue({
      output: { send: vi.fn(), deliveryErrors: () => ["chat not found"] },
    });

    await triggerAgentRun({ definitionId: "def-1", userId });

    await vi.waitFor(() => {
      expect(mockAgentRun.update).toHaveBeenCalledWith({
        where: { id: "run-1" },
        data: { deliveryError: "chat not found" },
      });
    });
  });

  it("writes no delivery error when everything got through", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(telegramDefinition);
    mockAgentRun.create.mockResolvedValue(pendingRun);
    vi.mocked(buildAgentOutputHandler).mockResolvedValue({
      output: { send: vi.fn(), deliveryErrors: () => [] },
    });

    await triggerAgentRun({ definitionId: "def-1", userId });

    await vi.waitFor(() => {
      expect(mockAgentRun.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
      );
    });

    const deliveryWrites = mockAgentRun.update.mock.calls.filter(
      ([call]: [{ data: Record<string, unknown> }]) => "deliveryError" in call.data,
    );
    // Only the "running" update, which clears the column for a fresh run.
    expect(deliveryWrites).toEqual([
      [{ where: { id: "run-1" }, data: expect.objectContaining({ deliveryError: null }) }],
    ]);
  });

  it("clears the delivery error for a definition with no output channel", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(channelLessDefinition);
    mockAgentRun.create.mockResolvedValue({ ...pendingRun, outputChannel: null });
    vi.mocked(buildAgentOutputHandler).mockResolvedValue({});

    await triggerAgentRun({ definitionId: "def-1", userId });

    expect(mockAgentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({ status: "running", deliveryError: null }),
    });
  });
});
