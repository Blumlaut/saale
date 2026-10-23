import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockGetLinkByUserId, mockCompactChatSession, mockEnsureHomeThread } = vi.hoisted(() => ({
  mockGetLinkByUserId: vi.fn(),
  mockCompactChatSession: vi.fn(),
  mockEnsureHomeThread: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/redis", () => ({}));
vi.mock("@/lib/uploads", () => ({ getUploadsDir: () => "/tmp/uploads" }));
vi.mock("@/lib/chat/compact-chat", () => ({
  compactChatSession: (...args: unknown[]) => mockCompactChatSession(...args),
  compactionOutcome: (result: { ok: boolean }) => ({
    message: result.ok ? "Conversation compacted." : "failed",
    tone: result.ok ? "success" : "error",
  }),
}));
vi.mock("@/lib/telegram/links", () => ({
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
}));
vi.mock("@/lib/telegram/routing", () => ({
  resolveTelegramTarget: vi.fn(),
  ensureHomeThread: (...args: unknown[]) => mockEnsureHomeThread(...args),
}));

import { compactTelegramSession } from "@/lib/telegram/processor";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const chatId = BigInt("119075844");

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
  vi.clearAllMocks();
  mockGetLinkByUserId.mockResolvedValue(link);
  mockCompactChatSession.mockResolvedValue({ ok: true, tokensBefore: 900 });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("compactTelegramSession", () => {
  it("compacts the chat the command was sent in", async () => {
    const outcome = await compactTelegramSession({
      userId,
      telegramChatId: chatId,
      sessionId: "sess-routed",
    });

    expect(mockCompactChatSession).toHaveBeenCalledWith({ userId, sessionId: "sess-routed" });
    expect(outcome.tone).toBe("success");
  });

  it("refuses when the account has no Telegram link", async () => {
    mockGetLinkByUserId.mockResolvedValue(null);

    const outcome = await compactTelegramSession({
      userId,
      telegramChatId: chatId,
      sessionId: "sess-routed",
    });

    expect(outcome.tone).toBe("error");
    expect(mockCompactChatSession).not.toHaveBeenCalled();
  });

  it("refuses when there is no conversation to compact", async () => {
    mockGetLinkByUserId.mockResolvedValue({ ...link, sessionId: null });

    const outcome = await compactTelegramSession({
      userId,
      telegramChatId: chatId,
      sessionId: null,
    });

    expect(outcome).toEqual({
      message: "No active chat session found. Send a message first.",
      tone: "error",
    });
    expect(mockCompactChatSession).not.toHaveBeenCalled();
  });
});
