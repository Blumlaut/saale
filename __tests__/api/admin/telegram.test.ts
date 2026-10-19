import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetTelegramBot,
  mockSaveTelegramBot,
  mockSetTelegramBotEnabled,
  mockRemoveTelegramBot,
  mockTelegramLinkCount,
  mockRequirePermission,
  mockGetTelegramLoginStatus,
} = vi.hoisted(() => ({
  mockGetTelegramBot: vi.fn(),
  mockSaveTelegramBot: vi.fn(),
  mockSetTelegramBotEnabled: vi.fn(),
  mockRemoveTelegramBot: vi.fn(),
  mockTelegramLinkCount: vi.fn(),
  mockRequirePermission: vi.fn(),
  mockGetTelegramLoginStatus: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: { telegramLink: { count: (...args: unknown[]) => mockTelegramLinkCount(...args) } },
}));

vi.mock("@/lib/telegram/oidc", () => ({
  getTelegramLoginStatus: (...args: unknown[]) => mockGetTelegramLoginStatus(...args),
}));

vi.mock("@/lib/telegram/bot", () => ({
  getTelegramBot: (...args: unknown[]) => mockGetTelegramBot(...args),
  saveTelegramBot: (...args: unknown[]) => mockSaveTelegramBot(...args),
  setTelegramBotEnabled: (...args: unknown[]) => mockSetTelegramBotEnabled(...args),
  removeTelegramBot: (...args: unknown[]) => mockRemoveTelegramBot(...args),
}));

import { DELETE, GET, PATCH, POST } from "@/app/api/admin/telegram/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Telegram sign-in's state as the route reports it. */
const loginStatus = {
  configured: true,
  clientId: "123456789",
  botId: "123456789",
  botUsername: "saale_bot",
  enabled: true,
  redirectUri: "https://saale.example.com/api/auth/callback/telegram-oidc",
};

function authenticate(role: "admin" | "user" = "admin") {
  if (role === "admin") {
    mockRequirePermission.mockResolvedValue({ ok: true, user: { id: "admin-1" } });
  } else {
    mockRequirePermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    });
  }
}

function jsonRequest(body: Record<string, unknown>, method = "POST") {
  return new NextRequest("http://localhost/api/admin/telegram", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const bot = {
  id: "global",
  encryptedToken: "enc(token)",
  enabled: true,
  botId: BigInt(123456789),
  botUsername: "saale_bot",
  webhookSecret: "secret",
  updatedByUserId: "admin-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTelegramLinkCount.mockResolvedValue(0);
  mockGetTelegramLoginStatus.mockResolvedValue(loginStatus);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("admin auth", () => {
  it("rejects a non-admin before touching anything", async () => {
    authenticate("user");

    expect((await GET()).status).toBe(403);
    expect((await POST(jsonRequest({ token: "x".repeat(20) }))).status).toBe(403);
    expect((await PATCH(jsonRequest({ enabled: false }, "PATCH"))).status).toBe(403);
    expect((await DELETE()).status).toBe(403);

    expect(mockGetTelegramBot).not.toHaveBeenCalled();
    expect(mockSaveTelegramBot).not.toHaveBeenCalled();
    expect(mockRemoveTelegramBot).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/telegram", () => {
  it("reports no bot configured", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body.bot).toEqual({ configured: false });
    expect(mockTelegramLinkCount).not.toHaveBeenCalled();
    // Sign-in's state is reported even with no bot: it is what explains the
    // misconfiguration.
    expect(body.login).toEqual(loginStatus);
  });

  it("reports the bot's identity and reach, never its token", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(bot);
    mockTelegramLinkCount.mockResolvedValue(3);

    const body = await (await GET()).json();

    expect(body.bot).toEqual({
      configured: true,
      enabled: true,
      botId: "123456789",
      botUsername: "saale_bot",
      linkCount: 3,
      updatedByUserId: "admin-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("enc(token)");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.login).toEqual(loginStatus);
  });

  it("spells out why Telegram sign-in is off when the client id is another bot", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(bot);
    mockGetTelegramLoginStatus.mockResolvedValue({
      ...loginStatus,
      clientId: "987654321",
      enabled: false,
    });

    const body = await (await GET()).json();

    expect(body.login).toMatchObject({ configured: true, enabled: false, clientId: "987654321" });
  });
});

describe("POST /api/admin/telegram", () => {
  it("rejects a missing or too-short token without calling Telegram", async () => {
    authenticate();

    expect((await POST(jsonRequest({ token: "short" }))).status).toBe(400);
    expect((await POST(jsonRequest({}))).status).toBe(400);
    expect(mockSaveTelegramBot).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    authenticate();

    const request = new NextRequest("http://localhost/api/admin/telegram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect((await POST(request)).status).toBe(400);
  });

  it("saves the token attributed to the acting admin", async () => {
    authenticate();
    mockSaveTelegramBot.mockResolvedValue({ bot, webhookRegistered: true });

    const token = "123456789:AAGWzUqz4aBcDeFgHiJkLmNoPqRsTuVwXyZ";
    const body = await (await POST(jsonRequest({ token }))).json();

    expect(mockSaveTelegramBot).toHaveBeenCalledWith({ token, adminUserId: "admin-1" });
    expect(body.webhookRegistered).toBe(true);
    expect(body.bot.configured).toBe(true);
  });

  it("trims a pasted token before validating it", async () => {
    authenticate();
    mockSaveTelegramBot.mockResolvedValue({ bot, webhookRegistered: true });

    await POST(jsonRequest({ token: "  123456789:AAGWzUqz4aBcDeFgHijkl  \n" }));

    expect(mockSaveTelegramBot).toHaveBeenCalledWith({
      token: "123456789:AAGWzUqz4aBcDeFgHijkl",
      adminUserId: "admin-1",
    });
  });

  it("surfaces an invalid token as a 400 with the reason", async () => {
    authenticate();
    mockSaveTelegramBot.mockRejectedValue(new Error("Unauthorized"));

    const response = await POST(jsonRequest({ token: "123456789:nonsense_nonsense" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Unauthorized");
  });

  it("still reports the saved bot when the webhook could not be published", async () => {
    authenticate();
    mockSaveTelegramBot.mockResolvedValue({ bot, webhookRegistered: false });

    const body = await (await POST(jsonRequest({ token: "123456789:valid_token_value" }))).json();

    expect(body.webhookRegistered).toBe(false);
    expect(body.bot.configured).toBe(true);
  });
});

describe("PATCH /api/admin/telegram", () => {
  it("rejects a body without an 'enabled' flag", async () => {
    authenticate();

    expect((await PATCH(jsonRequest({}, "PATCH"))).status).toBe(400);
    expect(mockSetTelegramBotEnabled).not.toHaveBeenCalled();
  });

  it("reports 404 when no bot exists", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(null);

    expect((await PATCH(jsonRequest({ enabled: false }, "PATCH"))).status).toBe(404);
    expect(mockSetTelegramBotEnabled).not.toHaveBeenCalled();
  });

  it("switches the bot off", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(bot);
    mockSetTelegramBotEnabled.mockResolvedValue({ ...bot, enabled: false });

    const body = await (await PATCH(jsonRequest({ enabled: false }, "PATCH"))).json();

    expect(mockSetTelegramBotEnabled).toHaveBeenCalledWith(false);
    expect(body.bot.enabled).toBe(false);
  });

  it("switches the bot on", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue({ ...bot, enabled: false });
    mockSetTelegramBotEnabled.mockResolvedValue(bot);

    const body = await (await PATCH(jsonRequest({ enabled: true }, "PATCH"))).json();

    expect(mockSetTelegramBotEnabled).toHaveBeenCalledWith(true);
    expect(body.bot.enabled).toBe(true);
  });
});

describe("DELETE /api/admin/telegram", () => {
  it("removes the bot", async () => {
    authenticate();
    mockRemoveTelegramBot.mockResolvedValue(true);

    expect((await DELETE()).status).toBe(200);
    expect(mockRemoveTelegramBot).toHaveBeenCalled();
  });

  it("reports 404 when no bot exists", async () => {
    authenticate();
    mockRemoveTelegramBot.mockResolvedValue(false);

    expect((await DELETE()).status).toBe(404);
  });
});
