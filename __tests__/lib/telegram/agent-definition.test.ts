import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockAgentDefinition } = vi.hoisted(() => ({
  mockAgentDefinition: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: { agentDefinition: mockAgentDefinition } }));

import { ensureTelegramAgentDefinition } from "@/lib/telegram/processor";
import { TELEGRAM_AGENT_NAME } from "@/lib/agent-jobs/system-managed";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";

/** A definition row as the lookup returns it. */
function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: "def-1",
    userId,
    name: TELEGRAM_AGENT_NAME,
    systemPrompt: "prompt",
    toolConfig: { email: true, calendar: true, terminal: true, agentJobs: true },
    modelId: null,
    thinkingLevel: "off",
    systemManaged: true,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ensureTelegramAgentDefinition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the definition with outreach and scheduling tools granted", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(null);
    mockAgentDefinition.create.mockResolvedValue(definition());

    await ensureTelegramAgentDefinition(userId);

    expect(mockAgentDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId,
        name: TELEGRAM_AGENT_NAME,
        systemManaged: true,
        toolConfig: expect.objectContaining({
          // Files arrive through Telegram, so the workspace tools are required.
          terminal: true,
          // The bot is where "remind me at 9" gets asked.
          agentJobs: true,
          telegram: true,
        }),
      }),
    });
  });

  it("grants agentJobs to an existing definition that predates it", async () => {
    // A definition created before scheduling was granted — the upgrade must not
    // depend on the user re-creating their bot.
    mockAgentDefinition.findFirst.mockResolvedValue(
      definition({ toolConfig: { email: true, calendar: true, terminal: true } }),
    );
    mockAgentDefinition.update.mockResolvedValue(
      definition({ toolConfig: { email: true, calendar: true, terminal: true, agentJobs: true } }),
    );

    await ensureTelegramAgentDefinition(userId);

    expect(mockAgentDefinition.update).toHaveBeenCalledWith({
      where: { id: "def-1" },
      data: {
        toolConfig: { email: true, calendar: true, terminal: true, agentJobs: true },
      },
    });
  });

  it("grants terminal to an existing definition that lost it", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(
      definition({ toolConfig: { email: true, agentJobs: true } }),
    );
    mockAgentDefinition.update.mockResolvedValue(
      definition({ toolConfig: { email: true, agentJobs: true, terminal: true } }),
    );

    await ensureTelegramAgentDefinition(userId);

    expect(mockAgentDefinition.update).toHaveBeenCalledWith({
      where: { id: "def-1" },
      data: { toolConfig: { email: true, agentJobs: true, terminal: true } },
    });
  });

  it("writes nothing when the definition already grants both", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(definition());

    await ensureTelegramAgentDefinition(userId);

    expect(mockAgentDefinition.update).not.toHaveBeenCalled();
    expect(mockAgentDefinition.create).not.toHaveBeenCalled();
  });

  it("adopts a pre-existing definition so the runtime lock applies to it", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(definition({ systemManaged: false }));
    mockAgentDefinition.update.mockResolvedValue(definition());

    const result = await ensureTelegramAgentDefinition(userId);

    expect(mockAgentDefinition.update).toHaveBeenCalledWith({
      where: { id: "def-1" },
      data: { systemManaged: true },
    });
    expect(result.id).toBe("def-1");
  });

  it("scopes the lookup to the user", async () => {
    mockAgentDefinition.findFirst.mockResolvedValue(null);
    mockAgentDefinition.create.mockResolvedValue(definition());

    await ensureTelegramAgentDefinition("user-2");

    expect(mockAgentDefinition.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-2", name: TELEGRAM_AGENT_NAME },
    });
  });
});
