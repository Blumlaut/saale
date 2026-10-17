import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ───────────────────────────────────────────────────────────────────

const { mockGetEnabledTelegramBot, mockSendTelegramMessage, mockLinkTelegramFromOidc } = vi.hoisted(
  () => ({
    mockGetEnabledTelegramBot: vi.fn(),
    mockSendTelegramMessage: vi.fn(),
    mockLinkTelegramFromOidc: vi.fn(),
  }),
);

vi.mock("@/lib/telegram/bot", () => ({
  getEnabledTelegramBot: (...args: unknown[]) => mockGetEnabledTelegramBot(...args),
}));

vi.mock("@/lib/telegram/client", () => ({
  getPublicBaseUrl: () => "http://localhost:3630",
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
  buildLinkSuccessMessage: () => "Linked.",
}));

vi.mock("@/lib/telegram/links", () => ({
  linkTelegramFromOidc: (...args: unknown[]) => mockLinkTelegramFromOidc(...args),
}));

const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

import {
  buildTelegramLoginRedirectUri,
  displayNameFromClaims,
  getTelegramLoginStatus,
  getTelegramOidcCredentials,
  linkTelegramFromOidcLogin,
  telegramOidcPlugins,
  telegramUserIdFromClaims,
} from "@/lib/telegram/oidc";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "TELEGRAM_OIDC_CLIENT_ID",
  "TELEGRAM_OIDC_CLIENT_SECRET",
  "BETTER_AUTH_URL",
] as const;

/** An id_token as `jose.decodeJwt` reads it: header, claims, signature. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
}

/** The configured bot, as `getEnabledTelegramBot` returns it. */
const bot = {
  id: "global",
  encryptedToken: "enc",
  enabled: true,
  botId: BigInt(555000111),
  botUsername: "saale_bot",
  webhookSecret: "secret",
  updatedByUserId: "admin-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const TELEGRAM_ACCOUNT_ID = "555000111";

/** The OIDC provider config the plugin registers. */
function providerConfig() {
  const [plugin] = telegramOidcPlugins();
  const config = plugin?.options.config[0];
  if (!config) throw new Error("the Telegram provider was not registered");
  return config;
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];

  mockGetEnabledTelegramBot.mockReset();
  mockGetEnabledTelegramBot.mockResolvedValue(bot);
  mockSendTelegramMessage.mockReset();
  mockSendTelegramMessage.mockResolvedValue([1]);
  mockLinkTelegramFromOidc.mockReset();
  mockLinkTelegramFromOidc.mockResolvedValue({ ok: true, link: { id: "link-1" } });
  consoleErrorSpy.mockClear();
  consoleWarnSpy.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ─── Identity from the claims ────────────────────────────────────────────────

describe("Telegram identity claims", () => {
  it("uses the profile scope's user id, not the sub Telegram may report differently", () => {
    const claims = { id: 987654321, sub: "1234123412341234123" };

    expect(telegramUserIdFromClaims(claims)).toBe("987654321");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("falls back to sub for a token that carries no id", () => {
    expect(telegramUserIdFromClaims({ sub: 1234567890 })).toBe("1234567890");
    // Ids beyond the safe integer range only survive as strings.
    expect(telegramUserIdFromClaims({ sub: "9007199254740993" })).toBe("9007199254740993");
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a numeric user id", () => {
    expect(telegramUserIdFromClaims({})).toBeNull();
    expect(telegramUserIdFromClaims({ id: "" })).toBeNull();
    expect(telegramUserIdFromClaims({ id: "user-1" })).toBeNull();
    expect(telegramUserIdFromClaims({ id: null, sub: [] })).toBeNull();
    expect(telegramUserIdFromClaims({ id: "  123  " })).toBe("123");
  });

  it("labels the account with a name, then the @handle", () => {
    expect(displayNameFromClaims({ name: "Ada Lovelace", preferred_username: "ada" })).toBe(
      "Ada Lovelace",
    );
    expect(displayNameFromClaims({ preferred_username: "ada" })).toBe("ada");
    expect(displayNameFromClaims({ given_name: "Ada" })).toBe("Ada");
    expect(displayNameFromClaims({})).toBeNull();
  });
});

// ─── Configuration ───────────────────────────────────────────────────────────

describe("Telegram login configuration", () => {
  it("needs both halves of the credentials", () => {
    expect(getTelegramOidcCredentials()).toBeNull();

    process.env.TELEGRAM_OIDC_CLIENT_ID = TELEGRAM_ACCOUNT_ID;
    expect(getTelegramOidcCredentials()).toBeNull();

    process.env.TELEGRAM_OIDC_CLIENT_SECRET = "  secret-1  ";
    expect(getTelegramOidcCredentials()).toEqual({
      clientId: TELEGRAM_ACCOUNT_ID,
      clientSecret: "secret-1",
    });
  });

  it("returns the callback Telegram must have registered", () => {
    expect(buildTelegramLoginRedirectUri()).toBe(
      "http://localhost:3630/api/auth/callback/telegram-oidc",
    );

    process.env.BETTER_AUTH_URL = "https://saale.example.com/";
    expect(buildTelegramLoginRedirectUri()).toBe(
      "https://saale.example.com/api/auth/callback/telegram-oidc",
    );
  });

  it("registers no provider until the instance has credentials", () => {
    expect(telegramOidcPlugins()).toEqual([]);

    process.env.TELEGRAM_OIDC_CLIENT_ID = TELEGRAM_ACCOUNT_ID;
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = "secret-1";

    const [plugin] = telegramOidcPlugins();
    expect(plugin?.id).toBe("generic-oauth");
    expect(providerConfig()).toMatchObject({
      providerId: "telegram-oidc",
      clientId: TELEGRAM_ACCOUNT_ID,
      clientSecret: "secret-1",
      requireIdTokenVerification: true,
      scopes: ["openid", "profile", "telegram:bot_access"],
    });
  });

  it("offers login only when the credentials name the bot that serves the chat", async () => {
    await expect(getTelegramLoginStatus()).resolves.toMatchObject({
      configured: false,
      enabled: false,
      botId: TELEGRAM_ACCOUNT_ID,
    });

    process.env.TELEGRAM_OIDC_CLIENT_ID = TELEGRAM_ACCOUNT_ID;
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = "secret-1";
    mockGetEnabledTelegramBot.mockResolvedValue({ ...bot, botId: BigInt(999) });
    await expect(getTelegramLoginStatus()).resolves.toMatchObject({
      configured: true,
      enabled: false,
    });

    mockGetEnabledTelegramBot.mockResolvedValue({ ...bot, botId: null });
    await expect(getTelegramLoginStatus()).resolves.toMatchObject({ enabled: false });

    mockGetEnabledTelegramBot.mockResolvedValue(null);
    await expect(getTelegramLoginStatus()).resolves.toMatchObject({ enabled: false });

    mockGetEnabledTelegramBot.mockResolvedValue(bot);
    await expect(getTelegramLoginStatus()).resolves.toMatchObject({
      configured: true,
      enabled: true,
      botUsername: "saale_bot",
      redirectUri: "http://localhost:3630/api/auth/callback/telegram-oidc",
    });
  });

  it("keeps the account key on the Telegram user id", () => {
    process.env.TELEGRAM_OIDC_CLIENT_ID = TELEGRAM_ACCOUNT_ID;
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = "secret-1";

    expect(
      providerConfig().accountSubject?.({
        tokens: {},
        profile: { sub: TELEGRAM_ACCOUNT_ID, id: TELEGRAM_ACCOUNT_ID, emailVerified: true },
      }),
    ).toBe(TELEGRAM_ACCOUNT_ID);
  });

  it("signs in only, leaving account creation to an explicit sign-up", () => {
    process.env.TELEGRAM_OIDC_CLIENT_ID = TELEGRAM_ACCOUNT_ID;
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = "secret-1";

    // better-auth drops the account creation when this is set and the request
    // did not carry `requestSignUp` — the register page sets that, the login
    // page does not. Setting `disableSignUp` instead would shut sign-ups out.
    expect(providerConfig().disableImplicitSignUp).toBe(true);
    expect(providerConfig().disableSignUp).toBeUndefined();
  });
});

// ─── The id_token as a profile ───────────────────────────────────────────────

describe("Telegram id_token handling", () => {
  beforeEach(() => {
    process.env.TELEGRAM_OIDC_CLIENT_ID = TELEGRAM_ACCOUNT_ID;
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = "secret-1";
  });

  it("maps verified claims onto a user, with an undeliverable address", async () => {
    const token = idToken({
      sub: "1234123412341234123",
      id: 987654321,
      name: "Ada Lovelace",
      preferred_username: "ada",
      picture: "https://cdn4.telesco.pe/file/ada.jpg",
    });

    const profile = await providerConfig().getUserInfo?.({ idToken: token });

    expect(profile).toMatchObject({
      sub: "987654321",
      name: "Ada Lovelace",
      image: "https://cdn4.telesco.pe/file/ada.jpg",
      email: "987654321@telegram.invalid",
      // Telegram never reports an email, so the invented one must not read as
      // verified.
      emailVerified: false,
    });
  });

  it("refuses a token it cannot identify a user from", async () => {
    expect(await providerConfig().getUserInfo?.({})).toBeNull();

    expect(await providerConfig().getUserInfo?.({ idToken: "not-a-jwt" })).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();

    const anonymous = idToken({ name: "Someone" });
    expect(await providerConfig().getUserInfo?.({ idToken: anonymous })).toBeNull();
  });
});

// ─── The login → link bridge ─────────────────────────────────────────────────

describe("linkTelegramFromOidcLogin", () => {
  beforeEach(() => {
    process.env.TELEGRAM_OIDC_CLIENT_ID = TELEGRAM_ACCOUNT_ID;
    process.env.TELEGRAM_OIDC_CLIENT_SECRET = "secret-1";
  });

  it("ignores accounts another provider created", async () => {
    await linkTelegramFromOidcLogin({
      userId: "user-1",
      providerId: "credential",
      accountId: TELEGRAM_ACCOUNT_ID,
    });

    expect(mockLinkTelegramFromOidc).not.toHaveBeenCalled();
  });

  it("links the Telegram account a login proved and greets the chat", async () => {
    await linkTelegramFromOidcLogin({
      userId: "user-1",
      providerId: "telegram-oidc",
      accountId: "987654321",
      idToken: idToken({ id: 987654321, name: "Ada Lovelace" }),
    });

    expect(mockLinkTelegramFromOidc).toHaveBeenCalledWith({
      userId: "user-1",
      telegramUserId: BigInt(987654321),
      displayName: "Ada Lovelace",
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("enc", BigInt(987654321), "Linked.", {
      parseMode: "HTML",
    });
  });

  it("still signs the user in when there is no bot to link to", async () => {
    mockGetEnabledTelegramBot.mockResolvedValue(null);

    await linkTelegramFromOidcLogin({
      userId: "user-1",
      providerId: "telegram-oidc",
      accountId: "987654321",
      idToken: null,
    });

    expect(mockLinkTelegramFromOidc).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("refuses an account id that is not a Telegram user id", async () => {
    await linkTelegramFromOidcLogin({
      userId: "user-1",
      providerId: "telegram-oidc",
      accountId: "ada",
    });

    expect(mockLinkTelegramFromOidc).not.toHaveBeenCalled();
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("reports a link owned by another user instead of taking it over", async () => {
    mockLinkTelegramFromOidc.mockResolvedValue({ ok: false, reason: "already_linked" });

    await linkTelegramFromOidcLogin({
      userId: "user-2",
      providerId: "telegram-oidc",
      accountId: "987654321",
      idToken: null,
    });

    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("already_linked"));
  });

  it("survives a chat the bot may not message", async () => {
    mockSendTelegramMessage.mockRejectedValue(new Error("bot can't initiate conversation"));

    await expect(
      linkTelegramFromOidcLogin({
        userId: "user-1",
        providerId: "telegram-oidc",
        accountId: "987654321",
        idToken: idToken({ id: 987654321 }),
      }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to greet"),
      expect.any(Error),
    );
  });
});
