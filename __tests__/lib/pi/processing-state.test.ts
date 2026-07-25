import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

// Mock Prisma
const mockChatSessionUpdate = vi.fn();
const mockChatSessionUpdateMany = vi.fn();
const mockChatSessionFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    chatSession: {
      update: (...args: unknown[]) => mockChatSessionUpdate(...args),
      updateMany: (...args: unknown[]) => mockChatSessionUpdateMany(...args),
      findMany: (...args: unknown[]) => mockChatSessionFindMany(...args),
    },
  },
}));

import {
  clearProcessingSince,
  startProcessingSince,
  isProcessingStale,
  clearStaleProcessingStates,
  buildAgentSystemPrompt,
} from "@/lib/pi/processing-state";

describe("clearProcessingSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears processingSince on the session", async () => {
    await clearProcessingSince("session-1");

    expect(mockChatSessionUpdate).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { processingSince: null },
    });
  });
});

describe("startProcessingSince", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets processingSince to now", async () => {
    await startProcessingSince("session-1");

    expect(mockChatSessionUpdate).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: { processingSince: expect.any(Date) },
    });
  });
});

describe("isProcessingStale", () => {
  it("returns false for null processingSince", () => {
    expect(isProcessingStale(null)).toBe(false);
  });

  it("returns false for recent processingSince", () => {
    expect(isProcessingStale(new Date())).toBe(false);
  });

  it("returns true for processingSince older than 10 minutes", () => {
    const oldDate = new Date(Date.now() - 11 * 60 * 1000);
    expect(isProcessingStale(oldDate)).toBe(true);
  });

  it("returns false for processingSince exactly at threshold boundary", () => {
    // Just under 10 minutes
    const nearThreshold = new Date(Date.now() - 9 * 60 * 1000);
    expect(isProcessingStale(nearThreshold)).toBe(false);
  });
});

describe("clearStaleProcessingStates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no stale sessions", async () => {
    mockChatSessionFindMany.mockResolvedValue([]);

    const result = await clearStaleProcessingStates();
    expect(result).toBe(0);
    expect(mockChatSessionUpdateMany).not.toHaveBeenCalled();
  });

  it("clears stale processingSince and active tool state", async () => {
    const staleThreshold = new Date(Date.now() - 11 * 60 * 1000);
    mockChatSessionFindMany.mockResolvedValue([
      { id: "session-1", processingSince: staleThreshold },
      { id: "session-2", processingSince: staleThreshold },
    ]);
    mockChatSessionUpdateMany.mockResolvedValue({ count: 2 });

    const result = await clearStaleProcessingStates();
    expect(result).toBe(2);

    // Should clear processingSince
    expect(mockChatSessionUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: ["session-1", "session-2"] },
        processingSince: { not: null },
      },
      data: { processingSince: null },
    });

    // Should also clear active tool state
    expect(mockChatSessionUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: { in: ["session-1", "session-2"] },
        activeToolName: { not: null },
      },
      data: {
        activeToolCallId: null,
        activeToolName: null,
        activeToolArgs: Prisma.JsonNull,
        activeToolStartedAt: null,
      },
    });
  });
});

describe("buildAgentSystemPrompt", () => {
  it("returns default prompt with no options", () => {
    const prompt = buildAgentSystemPrompt({});
    expect(prompt).toContain("You are Saale");
    expect(prompt).toContain("Be concise and direct");
    expect(prompt).not.toContain("Custom instructions");
    expect(prompt).not.toContain("Terminal");
    expect(prompt).toContain("persistent memory system");
  });

  it("includes custom instructions when provided", () => {
    const prompt = buildAgentSystemPrompt({
      customInstructions: "Always respond in Spanish.",
    });
    expect(prompt).toContain("Custom instructions:\nAlways respond in Spanish.");
  });

  it("skips empty custom instructions", () => {
    const prompt = buildAgentSystemPrompt({ customInstructions: "   " });
    expect(prompt).not.toContain("Custom instructions");
  });

  it("skips null custom instructions", () => {
    const prompt = buildAgentSystemPrompt({ customInstructions: null });
    expect(prompt).not.toContain("Custom instructions");
  });

  it("includes terminal instruction when terminal tool is enabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { terminal: true } });
    expect(prompt).toContain("A Terminal is available");
  });

  it("skips terminal instruction when terminal tool is disabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { terminal: false } });
    expect(prompt).not.toContain("A Terminal is available");
  });

  it("skips terminal instruction when not specified", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: {} });
    expect(prompt).not.toContain("A Terminal is available");
  });

  it("includes memory instruction by default", () => {
    const prompt = buildAgentSystemPrompt({});
    expect(prompt).toContain("persistent memory system");
  });

  it("skips memory instruction when explicitly disabled", () => {
    const prompt = buildAgentSystemPrompt({ toolConfig: { memory: false } });
    expect(prompt).not.toContain("persistent memory system");
  });

  it("includes all sections when all tools enabled", () => {
    const prompt = buildAgentSystemPrompt({
      customInstructions: "Be friendly.",
      toolConfig: { terminal: true, memory: true },
    });
    expect(prompt).toContain("You are Saale");
    expect(prompt).toContain("Custom instructions:\nBe friendly.");
    expect(prompt).toContain("A Terminal is available");
    expect(prompt).toContain("persistent memory system");
  });
});
