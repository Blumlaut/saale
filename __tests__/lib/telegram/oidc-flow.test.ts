/**
 * What a Telegram redirect is allowed to create.
 *
 * A sign-in is a sign-in: signing in creates an account only when the flow
 * carried `requestSignUp`  the register page sets it, the login page does not
 *  and the instance still has sign-ups open. Drives better-auth's own
 * endpoints against a stubbed Telegram, so the decisions under test are
 * better-auth's and the sign-up gate's, not a re-implementation of them.
 */

import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getHttpTestInstance } from "better-auth/test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const { state } = vi.hoisted(() => ({
  state: { signupsEnabled: true, userCount: 2 },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { count: async () => state.userCount, update: async () => ({}) },
    adminSettings: { findUnique: async () => ({ signupsEnabled: state.signupsEnabled }) },
  },
}));

vi.mock("@/lib/telegram/bot", () => ({
  getEnabledTelegramBot: async () => ({
    id: "global",
    encryptedToken: "enc",
    enabled: true,
    botId: BigInt(CLIENT_ID),
    botUsername: "saale_bot",
    webhookSecret: "secret",
    updatedByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
}));

vi.mock("@/lib/telegram/links", () => ({
  linkTelegramFromOidc: async () => ({ ok: true, link: { id: "link-1" } }),
}));

vi.mock("@/lib/telegram/client", () => ({
  getPublicBaseUrl: () => "http://localhost:3630",
  buildLinkSuccessMessage: () => "Linked.",
  sendTelegramMessage: async () => [1],
}));

// Discovery goes through better-auth's own fetch, not the global one, so the
// stubbed Telegram has to answer there too.
vi.mock("@better-fetch/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@better-fetch/fetch")>();

  return {
    ...actual,
    betterFetch: async (url: string, options?: unknown) => {
      if (typeof url === "string" && url.startsWith(ISSUER)) {
        return { data: await (await telegramFetch(url)).json(), error: null };
      }
      return actual.betterFetch(url as never, options as never);
    },
  };
});

const CLIENT_ID = "555000111";
const ISSUER = "https://oauth.telegram.org";

type Instance = Awaited<ReturnType<typeof getHttpTestInstance>>;

let instance: Instance;
let privateKey: CryptoKey;
let jwk: Record<string, unknown>;
/** The nonce better-auth sent on the authorization URL, echoed back in the id_token. */
let nonce: string | null = null;
/** The Telegram account this test signs in as  a fresh one every time. */
let telegramUserId = "777888999";

const realFetch = globalThis.fetch;

/** How many times the stubbed discovery document was asked for. */
let discoveryRequests = 0;

/** Telegram itself, faked: discovery, JWKS and a token endpoint that mints an id_token. */
async function telegramFetch(url: string): Promise<Response> {
  if (url.includes("openid-configuration")) {
    discoveryRequests += 1;
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile"],
      claims_supported: ["sub", "id", "name", "picture"],
    });
  }

  if (url.includes("jwks")) return Response.json({ keys: [jwk] });

  if (url.includes("/token")) {
    const idToken = await new SignJWT({
      id: telegramUserId,
      sub: telegramUserId,
      name: "Ada Lovelace",
      ...(nonce ? { nonce } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: "telegram-test" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    return Response.json({
      access_token: "telegram-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
    });
  }

  throw new Error(`the test Telegram was asked for something unexpected: ${url}`);
}

/** Every request Telegram would get, replaced. */
function stubTelegramFetch(): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(ISSUER) ? telegramFetch(url) : realFetch(input, init);
  });
}

/** Ask for the authorization URL, keeping the state cookie the callback needs. */
async function startTelegramFlow(
  body: Record<string, unknown>,
): Promise<{ url: URL; cookie: string }> {
  const response = await fetch(`${instance.baseURL}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: instance.baseURL },
    body: JSON.stringify({ provider: "telegram-oidc", ...body }),
    redirect: "manual",
  });

  expect(response.status, `sign-in answered ${response.status}`).toBe(200);
  const { url } = (await response.json()) as { url: string };
  const authorization = new URL(url);
  nonce = authorization.searchParams.get("nonce");

  return {
    url: authorization,
    cookie: response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  };
}

/** Come back from Telegram the way the browser does, and report where it landed. */
async function completeTelegramFlow(flow: { url: URL; cookie: string }): Promise<string> {
  const stateParam = flow.url.searchParams.get("state");
  if (!stateParam) throw new Error("the authorization URL carried no state");

  const response = await fetch(
    `${instance.baseURL}/api/auth/callback/telegram-oidc?code=test-code&state=${encodeURIComponent(stateParam)}`,
    { headers: { cookie: flow.cookie }, redirect: "manual" },
  );

  return response.headers.get("location") ?? "";
}

const telegramEmail = () => `${telegramUserId}@telegram.invalid`;

async function storedEmails(): Promise<string[]> {
  const users = (await instance.db.findMany({ model: "user" })) as Array<{ email: string }>;
  return users.map((user) => user.email);
}

beforeAll(async () => {
  const { publicKey, privateKey: generated } = await generateKeyPair("RS256");
  privateKey = generated;
  jwk = { ...(await exportJWK(publicKey)), kid: "telegram-test", alg: "RS256", use: "sig" };

  // Building the auth options discovers Telegram's endpoints and the provider is
  // registered from the credentials, so both have to be in place first.
  stubTelegramFetch();
  process.env.TELEGRAM_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.TELEGRAM_OIDC_CLIENT_SECRET = "secret-1";

  const { auth } = await import("@/auth");
  const { database: _database, ...productionOptions } = auth.options;

  instance = await getHttpTestInstance(productionOptions as Partial<BetterAuthOptions>, {
    disableTestUser: true,
  });
});

afterAll(async () => {
  await instance?.server.close();
});

let telegramSequence = 0;

beforeEach(() => {
  state.signupsEnabled = true;
  state.userCount = 2;
  nonce = null;
  // One Telegram account per test: the instance's database outlives them all,
  // and a leftover user would turn a sign-in into an accidental link.
  telegramUserId = String(777_000_000 + ++telegramSequence);
  stubTelegramFetch();
});

describe("Telegram redirect account creation", () => {
  it("signs nobody up for a Telegram account no Saale account is linked to", async () => {
    const flow = await startTelegramFlow({
      callbackURL: "/dashboard/chat",
      errorCallbackURL: "/auth/login?from=telegram",
    });

    const location = await completeTelegramFlow(flow);

    // Guards the harness itself: an unstubbed discovery would quietly talk to
    // the real Telegram (and fail anywhere without network).
    expect(discoveryRequests).toBeGreaterThan(0);
    expect(location).toContain("/auth/login?from=telegram");
    expect(location).toContain("error=signup_disabled");
    expect(await storedEmails()).not.toContain(telegramEmail());
  });

  it("creates the account, and the link, when the flow asks for a sign-up", async () => {
    const flow = await startTelegramFlow({
      callbackURL: "/dashboard/chat",
      requestSignUp: true,
    });

    const location = await completeTelegramFlow(flow);

    expect(location).toContain("/dashboard/chat");
    expect(await storedEmails()).toContain(telegramEmail());

    const accounts = (await instance.db.findMany({ model: "account" })) as Array<{
      providerId: string;
      accountId: string;
      userId: string;
    }>;
    expect(
      accounts.some(
        (account) => account.providerId === "telegram-oidc" && account.accountId === telegramUserId,
      ),
    ).toBe(true);
  });

  it("refuses that sign-up while an admin has sign-ups off", async () => {
    state.signupsEnabled = false;

    const flow = await startTelegramFlow({
      callbackURL: "/dashboard/chat",
      errorCallbackURL: "/auth/login",
      requestSignUp: true,
    });

    const location = await completeTelegramFlow(flow);

    expect(location).toContain("error=SIGNUPS_DISABLED");
    expect(await storedEmails()).not.toContain(telegramEmail());
  });

  it("still signs a linked Telegram account in with sign-ups off", async () => {
    const first = await completeTelegramFlow(
      await startTelegramFlow({ callbackURL: "/dashboard/chat", requestSignUp: true }),
    );
    expect(first).toContain("/dashboard/chat");

    // Same Telegram account, this time through the login page's button.
    state.signupsEnabled = false;
    const second = await completeTelegramFlow(
      await startTelegramFlow({ callbackURL: "/dashboard/chat", errorCallbackURL: "/auth/login" }),
    );

    expect(second).toContain("/dashboard/chat");
  });
});
