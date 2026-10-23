import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetLinkByUserId,
  mockChatMessage,
  mockChatSession,
  mockAppendCustomMessageEntry,
  mockContinueRecent,
  mockIsSessionBusy,
} = vi.hoisted(() => ({
  mockGetLinkByUserId: vi.fn(),
  mockChatMessage: { create: vi.fn() },
  mockChatSession: { findFirst: vi.fn(), update: vi.fn() },
  mockAppendCustomMessageEntry: vi.fn(),
  mockContinueRecent: vi.fn(),
  mockIsSessionBusy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { chatMessage: mockChatMessage, chatSession: mockChatSession },
}));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));

vi.mock("@/lib/redis", () => ({
  isSessionBusy: (...args: unknown[]) => mockIsSessionBusy(...args),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: {
    continueRecent: (...args: unknown[]) => mockContinueRecent(...args),
  },
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import { recordOutboundMessage } from "@/lib/telegram/outbound";

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
  sessionId: "sess-home",
  lastOutboundSessionId: null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  mockGetLinkByUserId.mockResolvedValue(link);
  mockChatSession.findFirst.mockResolvedValue({ id: "sess-home" });
  mockChatMessage.create.mockResolvedValue({ id: "msg-1" });
  mockChatSession.update.mockResolvedValue({});
  mockIsSessionBusy.mockResolvedValue(false);
  mockContinueRecent.mockReturnValue({
    appendCustomMessageEntry: mockAppendCustomMessageEntry,
  });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("recordOutboundMessage", () => {
  it("records into the chat that produced the message", async () => {
    await recordOutboundMessage({
      userId,
      content: "CVE-2026-1 affects lodash",
      sourceSessionId: "sess-source",
    });

    expect(mockChatMessage.create).toHaveBeenCalledWith({
      data: { sessionId: "sess-source", role: "assistant", content: "CVE-2026-1 affects lodash" },
    });
    expect(mockChatSession.update).toHaveBeenCalledWith({
      where: { id: "sess-source" },
      data: { lastActivityAt: expect.any(Date) },
    });

    // The Pi transcript entry is what gives the agent memory of the message.
    expect(mockAppendCustomMessageEntry).toHaveBeenCalledWith(
      "job_output",
      expect.stringContaining("CVE-2026-1 affects lodash"),
      false,
      expect.objectContaining({ channel: "telegram" }),
    );
  });

  it("falls back to the link's home thread when nothing in Saale sent the message", async () => {
    await recordOutboundMessage({ userId, content: "Standup in 5" });

    expect(mockChatMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sessionId: "sess-home" }),
    });
  });

  it("no-ops for blank content", async () => {
    await recordOutboundMessage({ userId, content: "   " });

    expect(mockGetLinkByUserId).not.toHaveBeenCalled();
    expect(mockChatMessage.create).not.toHaveBeenCalled();
  });

  it("no-ops when the user has not linked a Telegram account and no source is given", async () => {
    mockGetLinkByUserId.mockResolvedValue(null);

    await recordOutboundMessage({ userId, content: "hi" });

    expect(mockChatMessage.create).not.toHaveBeenCalled();
  });

  it("no-ops when the link has no session yet and no source is given", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, sessionId: null });

    await recordOutboundMessage({ userId, content: "hi" });

    expect(mockChatMessage.create).not.toHaveBeenCalled();
    expect(mockContinueRecent).not.toHaveBeenCalled();
  });

  it("refuses a source chat that belongs to another user", async () => {
    mockChatSession.findFirst.mockResolvedValue(null);

    await recordOutboundMessage({ userId, content: "hi", sourceSessionId: "someone-elses-chat" });

    expect(mockChatSession.findFirst).toHaveBeenCalledWith({
      where: { id: "someone-elses-chat", userId },
      select: { id: true },
    });
    expect(mockChatMessage.create).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown chat"));
  });

  it("writes the DB row but skips the transcript while the chat is generating", async () => {
    mockIsSessionBusy.mockResolvedValue(true);

    await recordOutboundMessage({ userId, content: "hi", sourceSessionId: "sess-source" });

    expect(mockChatMessage.create).toHaveBeenCalled();
    // Pi owns that transcript file for the duration of a run.
    expect(mockContinueRecent).not.toHaveBeenCalled();
  });

  it("surfaces a transcript-append failure after the DB half is written", async () => {
    mockAppendCustomMessageEntry.mockImplementation(() => {
      throw new Error("transcript write failed");
    });

    await expect(recordOutboundMessage({ userId, content: "hi" })).rejects.toThrow(
      "transcript write failed",
    );

    expect(mockChatMessage.create).toHaveBeenCalled();
  });

  it("keeps going when the session timestamp bump fails", async () => {
    mockChatSession.update.mockRejectedValue(new Error("db down"));

    await recordOutboundMessage({ userId, content: "hi" });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to bump lastActivityAt"),
      expect.any(Error),
    );
    // A stale sort order must not cost the agent its memory of the message.
    expect(mockAppendCustomMessageEntry).toHaveBeenCalled();
  });
});
