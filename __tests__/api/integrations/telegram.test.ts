import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const {
  mockGetTelegramBot,
  mockIssueLinkCode,
  mockUnlinkUser,
  mockGetLinkByUserId,
  mockHashLinkCode,
} = vi.hoisted(() => ({
  mockGetTelegramBot: vi.fn(),
  mockIssueLinkCode: vi.fn(),
  mockUnlinkUser: vi.fn(),
  mockGetLinkByUserId: vi.fn(),
  mockHashLinkCode: vi.fn((code: string) => `hash(${code})`),
}));

vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));

vi.mock("@/lib/telegram/bot", () => ({
  getTelegramBot: (...args: unknown[]) => mockGetTelegramBot(...args),
}));

vi.mock("@/lib/telegram/links", () => ({
  issueLinkCode: (...args: unknown[]) => mockIssueLinkCode(...args),
  unlinkUser: (...args: unknown[]) => mockUnlinkUser(...args),
  getLinkByUserId: (...args: unknown[]) => mockGetLinkByUserId(...args),
  hashLinkCode: (code: string) => mockHashLinkCode(code),
}));

import * as auth from "@/lib/auth";
import { DELETE, GET, POST } from "@/app/api/integrations/telegram/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const userId = "user-1";

function authenticate() {
  vi.mocked(auth.requireSession).mockResolvedValue({
    ok: true,
    user: { id: userId },
    response: null,
  } as never);
}

const postRequest = () =>
  new NextRequest("http://localhost/api/integrations/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

/** A configured, enabled bot row as `getTelegramBot` returns it. */
const bot = {
  id: "global",
  encryptedToken: "enc",
  enabled: true,
  botId: BigInt(1),
  botUsername: "saale_bot",
  webhookSecret: "secret",
  updatedByUserId: "admin-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

/** A link row as `getLinkByUserId` returns it. */
const link = {
  id: "link-1",
  userId,
  telegramUserId: BigInt("9007199254740993"),
  telegramChatId: BigInt("9007199254740993"),
  displayName: "Jane Doe",
  sessionId: null,
  createdAt: new Date("2026-02-01T00:00:00.000Z"),
  updatedAt: new Date("2026-02-01T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/integrations/telegram", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    expect((await GET()).status).toBe(401);
  });

  it("reports an unconfigured instance and no link", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(null);
    mockGetLinkByUserId.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body.integration).toEqual({
      bot: { configured: false, enabled: false, username: null },
      link: null,
    });
  });

  it("reports the linked account without ever exposing the bot token", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(bot);
    mockGetLinkByUserId.mockResolvedValue(link);

    const body = await (await GET()).json();

    expect(body.integration.bot).toEqual({
      configured: true,
      enabled: true,
      username: "saale_bot",
    });
    expect(body.integration.link).toEqual({
      telegramUserId: "9007199254740993",
      chatId: "9007199254740993",
      displayName: "Jane Doe",
      linkedAt: "2026-02-01T00:00:00.000Z",
    });
    // The token is instance infrastructure — it must not reach a user's browser.
    expect(JSON.stringify(body)).not.toContain("enc");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("reports a switched-off bot as configured but not enabled", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue({ ...bot, enabled: false });
    mockGetLinkByUserId.mockResolvedValue(null);

    const body = await (await GET()).json();

    expect(body.integration.bot).toEqual({
      configured: true,
      enabled: false,
      username: "saale_bot",
    });
  });

  it("scopes the link lookup to the authenticated user", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(bot);
    mockGetLinkByUserId.mockResolvedValue(null);

    await GET();

    expect(mockGetLinkByUserId).toHaveBeenCalledWith(userId);
  });
});

describe("POST /api/integrations/telegram", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    expect((await POST(postRequest())).status).toBe(401);
  });

  it("refuses to mint a code when no bot is configured", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(null);

    const response = await POST(postRequest());

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("admin");
    expect(mockIssueLinkCode).not.toHaveBeenCalled();
  });

  it("refuses to mint a code when the bot is switched off", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue({ ...bot, enabled: false });

    const response = await POST(postRequest());

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("switched off");
    expect(mockIssueLinkCode).not.toHaveBeenCalled();
  });

  it("refuses when the bot has no username to open a deep link with", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue({ ...bot, botUsername: null });

    const response = await POST(postRequest());

    expect(response.status).toBe(409);
    expect(mockIssueLinkCode).not.toHaveBeenCalled();
  });

  it("mints a code bound to the caller and a deep link that redeems it", async () => {
    authenticate();
    mockGetTelegramBot.mockResolvedValue(bot);
    mockIssueLinkCode.mockResolvedValue({
      code: "CODE_-abcDEF123_-abcDEF123_-abc",
      expiresAt: new Date("2026-02-01T00:10:00.000Z"),
    });

    const body = await (await POST(postRequest())).json();

    // The code is issued for the authenticated user — that binding is what
    // makes redeeming it in Telegram safe.
    expect(mockIssueLinkCode).toHaveBeenCalledWith(userId);
    expect(body.code).toBe("CODE_-abcDEF123_-abcDEF123_-abc");
    expect(body.botUsername).toBe("saale_bot");
    expect(body.deepLink).toBe("https://t.me/saale_bot?start=CODE_-abcDEF123_-abcDEF123_-abc");
    expect(body.expiresAt).toBe("2026-02-01T00:10:00.000Z");
  });
});

describe("DELETE /api/integrations/telegram", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.requireSession).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    expect((await DELETE()).status).toBe(401);
  });

  it("unlinks only the authenticated user's account", async () => {
    authenticate();
    mockUnlinkUser.mockResolvedValue(true);

    const response = await DELETE();

    expect(response.status).toBe(200);
    expect(mockUnlinkUser).toHaveBeenCalledWith(userId);
  });

  it("reports 404 when there was nothing linked", async () => {
    authenticate();
    mockUnlinkUser.mockResolvedValue(false);

    expect((await DELETE()).status).toBe(404);
  });
});
