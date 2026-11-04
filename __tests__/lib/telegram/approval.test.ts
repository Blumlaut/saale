import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A press on an approval card.
 *
 * One bot serves every user, and a forwarded card keeps its buttons, so the
 * presser's Telegram identity is what decides whose approval this is. These
 * cover that check, the token lookup behind the card, and the answers the user
 * gets for each way it can go.
 */

const h = vi.hoisted(() => ({
  redis: { get: vi.fn(), del: vi.fn() },
  chatSession: { findUnique: vi.fn() },
  getLinkByTelegramUserId: vi.fn(),
  resolveApproval: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({ getRedis: () => h.redis }));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: h.chatSession } }));

vi.mock("@/lib/telegram/links", () => ({
  getLinkByTelegramUserId: (...args: unknown[]) => h.getLinkByTelegramUserId(...args),
  getLinkByUserId: vi.fn(),
}));

vi.mock("@/lib/telegram/bot", () => ({ getEnabledTelegramBot: vi.fn() }));

vi.mock("@/lib/telegram/client", () => ({ createBot: vi.fn() }));

vi.mock("@/lib/pi/tool-approval-gate", () => ({
  resolveApproval: (...args: unknown[]) => h.resolveApproval(...args),
}));

import { handleApprovalCallback } from "@/lib/telegram/approval";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TOKEN = "0123456789abcdef";
const SESSION = "sess-1";
const PRESSER = BigInt(42);

beforeEach(() => {
  vi.clearAllMocks();
  h.redis.get.mockResolvedValue(JSON.stringify({ sessionId: SESSION, toolCallId: "tool-1" }));
  h.redis.del.mockResolvedValue(1);
  h.getLinkByTelegramUserId.mockResolvedValue({ userId: "user-1" });
  h.chatSession.findUnique.mockResolvedValue({ userId: "user-1" });
  h.resolveApproval.mockResolvedValue(true);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("handleApprovalCallback", () => {
  it("approves the tool call the card names", async () => {
    const result = await handleApprovalCallback(`a:${TOKEN}`, PRESSER);

    expect(h.redis.get).toHaveBeenCalledWith(`saale:approval-token:${TOKEN}`);
    expect(h.resolveApproval).toHaveBeenCalledWith(SESSION, "tool-1", true);
    expect(result).toEqual({ handled: true, message: "✅ Tool call approved.", approved: true });
    // The token is spent, so a second press on the same card cannot decide again.
    expect(h.redis.del).toHaveBeenCalledWith(`saale:approval-token:${TOKEN}`);
  });

  it("denies it when the button says no", async () => {
    const result = await handleApprovalCallback(`d:${TOKEN}`, PRESSER);

    expect(h.resolveApproval).toHaveBeenCalledWith(SESSION, "tool-1", false);
    expect(result).toMatchObject({ handled: true, approved: false });
    expect(result.message).toContain("denied");
  });

  it("refuses a press from an account that does not own the approval", async () => {
    h.getLinkByTelegramUserId.mockResolvedValue({ userId: "someone-else" });

    const result = await handleApprovalCallback(`a:${TOKEN}`, PRESSER);

    expect(result.message).toContain("different account");
    expect(h.resolveApproval).not.toHaveBeenCalled();
    // The token survives: the real owner can still press their own card.
    expect(h.redis.del).not.toHaveBeenCalled();
  });

  it("refuses a press whose session is gone", async () => {
    h.chatSession.findUnique.mockResolvedValue(null);

    const result = await handleApprovalCallback(`a:${TOKEN}`, PRESSER);

    expect(result.message).toContain("different account");
    expect(h.resolveApproval).not.toHaveBeenCalled();
  });

  it("reports an approval that expired before the press", async () => {
    h.redis.get.mockResolvedValue(null);

    const result = await handleApprovalCallback(`a:${TOKEN}`, PRESSER);

    expect(result).toEqual({ handled: true, message: "⚠️ Approval request expired or not found." });
    expect(h.resolveApproval).not.toHaveBeenCalled();
  });

  it("reports an approval that resolved before the press landed", async () => {
    h.resolveApproval.mockResolvedValue(false);

    const result = await handleApprovalCallback(`a:${TOKEN}`, PRESSER);

    expect(result).toEqual({
      handled: true,
      message: "⚠️ Approval request not found (may have expired).",
      approved: false,
    });
  });

  it("leaves anything that is not an approval press to the next handler", async () => {
    expect(await handleApprovalCallback("x:0123456789abcdef", PRESSER)).toEqual({ handled: false });
    expect(await handleApprovalCallback("a:short", PRESSER)).toEqual({ handled: false });
    expect(h.redis.get).not.toHaveBeenCalled();
  });
});
