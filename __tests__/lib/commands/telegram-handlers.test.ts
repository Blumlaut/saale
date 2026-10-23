import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockCreateChatSessionRow, mockSetActiveTelegramSession, mockCompactChatSession } =
  vi.hoisted(() => ({
    mockCreateChatSessionRow: vi.fn(),
    mockSetActiveTelegramSession: vi.fn(),
    mockCompactChatSession: vi.fn(),
  }));

vi.mock("@/lib/chat/create-session", () => ({
  createChatSessionRow: (...args: unknown[]) => mockCreateChatSessionRow(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  setActiveTelegramSession: (...args: unknown[]) => mockSetActiveTelegramSession(...args),
}));

vi.mock("@/lib/chat/compact-chat", () => ({
  compactChatSession: (...args: unknown[]) => mockCompactChatSession(...args),
  compactionOutcome: (result: { ok: boolean }) => ({
    message: result.ok ? "Conversation compacted." : "failed",
    tone: result.ok ? "success" : "error",
  }),
}));

import { compactHandler } from "@/lib/commands/handlers/compact";
import { newHandler } from "@/lib/commands/handlers/new";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";

/** A Telegram command with no conversation behind it. */
const telegramContext = {
  surface: "telegram" as const,
  userId,
  args: "",
  telegramChatId: BigInt("119075844"),
  encryptedToken: "enc",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateChatSessionRow.mockResolvedValue({
    id: "sess-new",
    title: "New Chat",
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
  });
  mockSetActiveTelegramSession.mockResolvedValue(undefined);
});

// ─── /new ────────────────────────────────────────────────────────────────────

describe("/new", () => {
  it("creates an ordinary chat and points the link at it", async () => {
    const outcome = await newHandler.run(telegramContext);

    expect(mockCreateChatSessionRow).toHaveBeenCalledWith(userId);
    // The next message that answers nothing runs in this chat.
    expect(mockSetActiveTelegramSession).toHaveBeenCalledWith(userId, "sess-new");
    expect(outcome.tone).toBe("success");
  });

  it("does not act on a web chat", async () => {
    const outcome = await newHandler.run({
      surface: "web",
      userId,
      args: "",
      sessionId: "sess-web",
    });

    expect(mockCreateChatSessionRow).not.toHaveBeenCalled();
    expect(outcome.tone).toBe("info");
  });
});

// ─── /compact without a chat ────────────────────────────────────────────────

describe("/compact", () => {
  it("says there is nothing to compact when the message belongs to no chat", async () => {
    const outcome = await compactHandler.run(telegramContext);

    expect(mockCompactChatSession).not.toHaveBeenCalled();
    expect(outcome.tone).toBe("info");
  });

  it("compacts the chat the command was sent in", async () => {
    mockCompactChatSession.mockResolvedValue({ ok: true });

    const outcome = await compactHandler.run({
      ...telegramContext,
      sessionId: "sess-active",
    });

    expect(mockCompactChatSession).toHaveBeenCalledWith({
      userId,
      sessionId: "sess-active",
    });
    expect(outcome.message).toBe("Conversation compacted.");
  });
});
