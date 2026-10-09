import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetLinkByUserId,
  mockChatMessage,
  mockChatSession,
  mockAppendCustomMessageEntry,
  mockContinueRecent,
} = vi.hoisted(() => ({
  mockGetLinkByUserId: vi.fn(),
  mockChatMessage: { create: vi.fn() },
  mockChatSession: { update: vi.fn() },
  mockAppendCustomMessageEntry: vi.fn(),
  mockContinueRecent: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatMessage: mockChatMessage, chatSession: mockChatSession },
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    continueRecent: (...args: unknown[]) => mockContinueRecent(...args),
  },
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

import { recordTelegramJobOutput } from "@/lib/telegram/outbound";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const chatId = BigInt("119075844");

/** A linked account with a live chat session. */
const link = {
  id: "link-1",
  userId,
  telegramUserId: chatId,
  telegramChatId: chatId,
  displayName: "Jane",
  sessionId: "sess-1",
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  mockGetLinkByUserId.mockResolvedValue(link);
  mockChatMessage.create.mockResolvedValue({ id: "msg-1" });
  mockChatSession.update.mockResolvedValue({});
  mockContinueRecent.mockReturnValue({
    appendCustomMessageEntry: mockAppendCustomMessageEntry,
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("recordTelegramJobOutput", () => {
  it("persists the message to the chat session and the Pi transcript", async () => {
    await recordTelegramJobOutput({ userId, content: "Daily digest ready" });

    expect(mockChatMessage.create).toHaveBeenCalledWith({
      data: { sessionId: "sess-1", role: "assistant", content: "Daily digest ready" },
    });
    expect(mockChatSession.update).toHaveBeenCalledWith({
      where: { id: "sess-1" },
      data: { lastActivityAt: expect.any(Date) },
    });

    // The Pi transcript entry is what gives the agent memory of the message.
    expect(mockAppendCustomMessageEntry).toHaveBeenCalledWith(
      "job_output",
      expect.stringContaining("Daily digest ready"),
      false,
      expect.objectContaining({ channel: "telegram" }),
    );
  });

  it("no-ops for blank content", async () => {
    await recordTelegramJobOutput({ userId, content: "   " });

    expect(mockGetLinkByUserId).not.toHaveBeenCalled();
    expect(mockChatMessage.create).not.toHaveBeenCalled();
  });

  it("no-ops when the user has not linked a Telegram account", async () => {
    mockGetLinkByUserId.mockResolvedValue(null);

    await recordTelegramJobOutput({ userId, content: "hi" });

    expect(mockChatMessage.create).not.toHaveBeenCalled();
    expect(mockContinueRecent).not.toHaveBeenCalled();
  });

  it("no-ops when the link has no session yet (never messaged the bot)", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, sessionId: null });

    await recordTelegramJobOutput({ userId, content: "hi" });

    expect(mockChatMessage.create).not.toHaveBeenCalled();
    expect(mockContinueRecent).not.toHaveBeenCalled();
  });

  it("surfaces a transcript-append failure after the DB half is written", async () => {
    mockAppendCustomMessageEntry.mockImplementation(() => {
      throw new Error("transcript write failed");
    });

    await expect(recordTelegramJobOutput({ userId, content: "hi" })).rejects.toThrow(
      "transcript write failed",
    );

    // The DB half already landed before the transcript append failed.
    expect(mockChatMessage.create).toHaveBeenCalled();
  });

  it("keeps going when the session timestamp bump fails", async () => {
    mockChatSession.update.mockRejectedValue(new Error("db down"));

    await recordTelegramJobOutput({ userId, content: "hi" });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to bump lastActivityAt"),
      expect.any(Error),
    );
    // A stale sort order must not cost the agent its memory of the message.
    expect(mockAppendCustomMessageEntry).toHaveBeenCalled();
  });

  it("resolves the session from the caller's own link only", async () => {
    await recordTelegramJobOutput({ userId, content: "hi" });

    expect(mockGetLinkByUserId).toHaveBeenCalledWith(userId);
    expect(mockChatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sessionId: "sess-1" }),
    });
  });
});
