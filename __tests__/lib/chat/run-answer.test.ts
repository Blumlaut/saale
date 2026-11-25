import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * "Is this message answered?" is what tells a leftover run record from a run
 * that still owes the chat a reply. The rule has to be the one a run actually
 * follows, or a resumed run either answers a message twice or leaves one
 * hanging.
 */

const mockFindFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { chatMessage: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
}));

import { hasFinalAnswer } from "@/lib/chat/run-answer";

const SESSION_ID = "chat-1";
const SINCE = new Date("2026-11-13T09:00:00Z");

describe("hasFinalAnswer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts only a turn that asked for nothing, after the run began", async () => {
    mockFindFirst.mockResolvedValue({ id: "assistant-1" });

    expect(await hasFinalAnswer(SESSION_ID, SINCE)).toBe(true);
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: {
        sessionId: SESSION_ID,
        role: "assistant",
        createdAt: { gt: SINCE },
        // A turn that called tools is the run's work in progress: the model
        // reads the results and goes on.
        toolCalls: null,
        content: { not: "" },
      },
      select: { id: true },
    });
  });

  it("reports a run that has not answered yet", async () => {
    mockFindFirst.mockResolvedValue(null);

    expect(await hasFinalAnswer(SESSION_ID, SINCE)).toBe(false);
  });
});
