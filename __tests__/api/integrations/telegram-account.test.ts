import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockTelegramAccount, mockRegisterWebhook, mockDeleteWebhook, mockResolveNotifyChat } =
  vi.hoisted(() => ({
    mockTelegramAccount: { findUnique: vi.fn(), update: vi.fn() },
    mockRegisterWebhook: vi.fn(),
    mockDeleteWebhook: vi.fn(),
    mockResolveNotifyChat: vi.fn(),
  }));

vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: { telegramAccount: mockTelegramAccount } }));

vi.mock("@/lib/telegram", () => ({
  validateBotToken: vi.fn(),
  registerWebhook: (...args: unknown[]) => mockRegisterWebhook(...args),
  deleteWebhook: (...args: unknown[]) => mockDeleteWebhook(...args),
}));

const mockIsKnownTelegramChat = vi.fn();
vi.mock("@/lib/telegram/chats", () => ({
  resolveNotifyChat: (...args: unknown[]) => mockResolveNotifyChat(...args),
  isKnownTelegramChat: (...args: unknown[]) => mockIsKnownTelegramChat(...args),
}));

import * as auth from "@/lib/auth";
import { GET, PATCH } from "@/app/api/integrations/telegram/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const userId = "user-1";

function authenticate() {
  vi.mocked(auth.requireSession).mockResolvedValue({
    ok: true,
    user: { id: userId },
    response: null,
  } as never);
}

function jsonRequest(body: Record<string, unknown>, method = "PATCH") {
  return new NextRequest("http://localhost/api/integrations/telegram", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An account row as the PATCH handler loads it. */
const account = {
  id: "acc-1",
  userId,
  encryptedToken: "enc",
  enabled: true,
  botId: BigInt(1),
  botUsername: "saale_bot",
  webhookSecret: "secret",
  notifyChatId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/integrations/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    expect((await GET()).status).toBe(401);
  });

  it("reports the pinned chat and where notifications currently go", async () => {
    authenticate();
    mockTelegramAccount.findUnique.mockResolvedValue({
      ...account,
      notifyChatId: BigInt("119075844"),
      _count: { whitelistedUsers: 2 },
    });
    mockResolveNotifyChat.mockResolvedValue({
      chatId: BigInt("119075844"),
      label: "Jane",
      source: "pinned",
    });

    const body = await (await GET()).json();

    expect(body.account.notifyChatId).toBe("119075844");
    expect(body.account.notifyChat).toEqual({
      chatId: "119075844",
      label: "Jane",
      source: "pinned",
    });
    expect(mockResolveNotifyChat).toHaveBeenCalledWith("acc-1", BigInt("119075844"));
  });

  it("reports no notification target when nothing is reachable", async () => {
    authenticate();
    mockTelegramAccount.findUnique.mockResolvedValue({
      ...account,
      _count: { whitelistedUsers: 0 },
    });
    mockResolveNotifyChat.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body.account.notifyChatId).toBeNull();
    expect(body.account.notifyChat).toBeNull();
  });
});

describe("PATCH /api/integrations/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate();
    mockTelegramAccount.findUnique.mockResolvedValue(account);
    mockRegisterWebhook.mockResolvedValue(true);
    mockDeleteWebhook.mockResolvedValue(true);
    mockResolveNotifyChat.mockResolvedValue(null);
  });

  it("pins a chat the bot already knows", async () => {
    mockIsKnownTelegramChat.mockResolvedValue(true);
    mockTelegramAccount.update.mockResolvedValue({
      ...account,
      notifyChatId: BigInt("119075844"),
    });

    const response = await PATCH(jsonRequest({ notifyChatId: "119075844" }));

    expect(response.status).toBe(200);
    expect(mockIsKnownTelegramChat).toHaveBeenCalledWith("acc-1", BigInt("119075844"));
    expect(mockTelegramAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notifyChatId: BigInt("119075844") } }),
    );
    // Pinning is not an enable/disable — the webhook must be left alone.
    expect(mockRegisterWebhook).not.toHaveBeenCalled();
    expect(mockDeleteWebhook).not.toHaveBeenCalled();
  });

  it("clears the pin back to automatic resolution", async () => {
    mockTelegramAccount.update.mockResolvedValue({ ...account, notifyChatId: null });

    const response = await PATCH(jsonRequest({ notifyChatId: null }));

    expect(response.status).toBe(200);
    expect(mockTelegramAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { notifyChatId: null } }),
    );
    // Nothing to validate when clearing.
    expect(mockIsKnownTelegramChat).not.toHaveBeenCalled();
  });

  it("rejects a chat the bot has never seen", async () => {
    mockIsKnownTelegramChat.mockResolvedValue(false);

    const response = await PATCH(jsonRequest({ notifyChatId: "999999" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("not known to this bot");
    // A bad pin must not be written — it would silently break every reminder.
    expect(mockTelegramAccount.update).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric chat ID", async () => {
    const response = await PATCH(jsonRequest({ notifyChatId: "not-a-chat" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("must be a Telegram chat ID");
    expect(mockTelegramAccount.update).not.toHaveBeenCalled();
  });

  it("rejects a body that changes nothing", async () => {
    const response = await PATCH(jsonRequest({}));

    expect(response.status).toBe(400);
    expect(mockTelegramAccount.update).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no integration", async () => {
    mockTelegramAccount.findUnique.mockResolvedValue(null);

    const response = await PATCH(jsonRequest({ enabled: false }));

    expect(response.status).toBe(404);
  });

  it("still registers and removes the webhook when toggling enabled", async () => {
    mockTelegramAccount.update.mockResolvedValue({ ...account, enabled: false });
    await PATCH(jsonRequest({ enabled: false }));
    expect(mockDeleteWebhook).toHaveBeenCalledWith("enc");

    vi.clearAllMocks();
    authenticate();
    mockTelegramAccount.findUnique.mockResolvedValue({ ...account, enabled: false });
    mockTelegramAccount.update.mockResolvedValue({ ...account, enabled: true });
    mockResolveNotifyChat.mockResolvedValue(null);

    await PATCH(jsonRequest({ enabled: true }));
    expect(mockRegisterWebhook).toHaveBeenCalledWith("enc", "acc-1", "secret");
  });

  it("applies both fields when sent together", async () => {
    mockIsKnownTelegramChat.mockResolvedValue(true);
    mockTelegramAccount.update.mockResolvedValue({
      ...account,
      enabled: true,
      notifyChatId: BigInt("119075844"),
    });

    await PATCH(jsonRequest({ enabled: true, notifyChatId: "119075844" }));

    expect(mockTelegramAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { enabled: true, notifyChatId: BigInt("119075844") },
      }),
    );
  });
});
