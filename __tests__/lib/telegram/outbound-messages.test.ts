import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockOutbound, mockLink, mockTransaction } = vi.hoisted(() => ({
  mockOutbound: { createMany: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn() },
  mockLink: { updateMany: vi.fn() },
  mockTransaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    telegramOutboundMessage: mockOutbound,
    telegramLink: mockLink,
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

import {
  findOutboundSource,
  OUTBOUND_TTL_DAYS,
  recordOutboundMessages,
} from "@/lib/telegram/outbound-messages";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const userId = "user-1";
const chatId = BigInt("119075844");

beforeEach(() => {
  vi.resetAllMocks();
  mockTransaction.mockResolvedValue([]);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("recordOutboundMessages", () => {
  it("writes one row per Telegram message, all naming the source chat", async () => {
    await recordOutboundMessages({
      userId,
      chatId,
      messageIds: [41, 42],
      sourceSessionId: "sess-1",
    });

    expect(mockOutbound.createMany).toHaveBeenCalledWith({
      data: [
        { userId, botId: "global", chatId, messageId: BigInt(41), sessionId: "sess-1" },
        { userId, botId: "global", chatId, messageId: BigInt(42), sessionId: "sess-1" },
      ],
      skipDuplicates: true,
    });
    // The link remembers the chat that spoke last, for a reply that quotes nothing.
    expect(mockLink.updateMany).toHaveBeenCalledWith({
      where: { userId },
      data: { lastOutboundSessionId: "sess-1" },
    });
  });

  it("leaves the link's last-sent chat alone when the delivery had no source", async () => {
    await recordOutboundMessages({ userId, chatId, messageIds: [7] });

    expect(mockOutbound.createMany).toHaveBeenCalledWith({
      data: [{ userId, botId: "global", chatId, messageId: BigInt(7), sessionId: null }],
      skipDuplicates: true,
    });
    expect(mockLink.updateMany).not.toHaveBeenCalled();
  });

  it("prunes this user's aged-out rows on every delivery", async () => {
    await recordOutboundMessages({ userId, chatId, messageIds: [1] });

    const [prune] = mockOutbound.deleteMany.mock.calls[0]!;
    expect(prune.where.userId).toBe(userId);
    const cutoff = (prune.where.createdAt.lt as Date).getTime();
    const expected = Date.now() - OUTBOUND_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(5_000);
  });

  it("does nothing when the send produced no message ids", async () => {
    await recordOutboundMessages({ userId, chatId, messageIds: [] });

    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe("findOutboundSource", () => {
  it("returns the chat that sent the replied-to message", async () => {
    mockOutbound.findUnique.mockResolvedValue({ userId, sessionId: "sess-1" });

    const source = await findOutboundSource({ userId, chatId, messageId: BigInt(42) });

    expect(source).toBe("sess-1");
    expect(mockOutbound.findUnique).toHaveBeenCalledWith({
      where: { chatId_messageId: { chatId, messageId: BigInt(42) } },
      select: { userId: true, sessionId: true },
    });
  });

  it("refuses a message id recorded for another account", async () => {
    mockOutbound.findUnique.mockResolvedValue({ userId: "user-2", sessionId: "sess-2" });

    const source = await findOutboundSource({ userId, chatId, messageId: BigInt(42) });

    expect(source).toBeNull();
  });

  it("returns null for a message it never sent", async () => {
    mockOutbound.findUnique.mockResolvedValue(null);

    const source = await findOutboundSource({ userId, chatId, messageId: BigInt(1) });

    expect(source).toBeNull();
  });

  it("returns null for a row with no source chat", async () => {
    mockOutbound.findUnique.mockResolvedValue({ userId, sessionId: null });

    const source = await findOutboundSource({ userId, chatId, messageId: BigInt(1) });

    expect(source).toBeNull();
  });
});
