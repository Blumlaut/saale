// Set env before the crypto and public-url modules read it.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.BETTER_AUTH_URL = "https://saale.example";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { startFakeMcpServer, type FakeMcpServer } from "../../helpers/fake-mcp-server";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../helpers/fake-oauth-server";

/** In-memory stand-ins for the two stores the OAuth flow writes to. */
const store = vi.hoisted(() => ({
  credentials: new Map<string, Record<string, unknown>>(),
  redis: new Map<string, string>(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mcpOAuthCredential: {
      findUnique: vi.fn(
        async ({ where }: { where: { serverId: string } }) =>
          store.credentials.get(where.serverId) ?? null,
      ),
      findFirst: vi.fn(async ({ where }: { where: { serverId: string; userId: string } }) => {
        const row = store.credentials.get(where.serverId);
        return row && row.userId === where.userId ? row : null;
      }),
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; serverId: { in: string[] } } }) =>
          [...store.credentials.values()]
            .filter(
              (row) =>
                row.userId === where.userId && where.serverId.in.includes(row.serverId as string),
            )
            .map((row) => ({ serverId: row.serverId })),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { serverId: string; userId: string } }) => {
        let count = 0;
        const row = store.credentials.get(where.serverId);
        if (row && row.userId === where.userId) {
          store.credentials.delete(where.serverId);
          count = 1;
        }
        return { count };
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { serverId: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = store.credentials.get(where.serverId);
          const row = existing
            ? { ...existing, ...update }
            : { serverId: where.serverId, ...create };
          store.credentials.set(where.serverId, row);
          return row;
        },
      ),
    },
  },
}));

vi.mock("@/lib/redis", () => ({
  getRedis: () => ({
    set: vi.fn(async (key: string, value: string) => {
      store.redis.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => store.redis.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) =>
      keys.reduce((count, key) => count + (store.redis.delete(key) ? 1 : 0), 0),
    ),
    eval: vi.fn(async () => 1),
  }),
}));

import {
  clearMcpOAuthCredential,
  completeMcpOAuthSignIn,
  createMcpAuthProvider,
  hasMcpOAuthCredential,
  loadMcpOAuthCredentialIds,
  markMcpOAuthSignInSucceeded,
  mcpOAuthRedirectUrl,
  readMcpOAuthFlow,
  resolveMcpOAuthState,
  startMcpOAuthSignIn,
} from "@/lib/mcp/oauth";
import { probeMcpServer } from "@/lib/mcp/probe";

const USER_ID = "user-1";
const SERVER_ID = "srv-1";

describe("MCP OAuth", () => {
  let as: FakeOAuthServer;
  let mcp: FakeMcpServer;

  beforeEach(async () => {
    store.credentials.clear();
    store.redis.clear();

    as = await startFakeOAuthServer();
    mcp = await startFakeMcpServer({
      requireToken: as.accessToken,
      challenge: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource"`,
      tools: [{ name: "HassTurnOn", description: "Turn something on" }],
    });
    as.setResourceUrl(mcp.url);
  });

  afterEach(async () => {
    await mcp.close();
    await as.close();
  });

  function server() {
    return { id: SERVER_ID, userId: USER_ID, name: "fakehome", url: mcp.url };
  }

  /** Drive a full sign-in the way the settings page and browser do. */
  async function signIn(): Promise<void> {
    const target = server();

    // A connection with no credentials asks the server, learns where to sign
    // in, and reports that the user must.
    await probeMcpServer({
      url: target.url,
      authProvider: createMcpAuthProvider(target),
    }).catch((err) => {
      if (!(err instanceof McpOAuthAuthorizationRequiredError)) throw err;
    });

    const start = await startMcpOAuthSignIn(target);
    if (start.status !== "pending" || !start.authorizationUrl) {
      throw new Error("expected a browser sign-in");
    }

    const redirect = await fetch(start.authorizationUrl, { redirect: "manual" });
    const callback = new URL(redirect.headers.get("location") ?? "");
    await completeMcpOAuthSignIn(target, { code: callback.searchParams.get("code") ?? "" });
    await markMcpOAuthSignInSucceeded(USER_ID, SERVER_ID);
  }

  it("uses the public app URL as the redirect URI", () => {
    expect(mcpOAuthRedirectUrl()).toBe("https://saale.example/api/mcp/oauth/callback");
  });

  it("completes a sign-in and authenticates with the stored token", async () => {
    const target = server();

    // The connection test learns where the server wants the sign-in to happen.
    await expect(
      probeMcpServer({ url: target.url, authProvider: createMcpAuthProvider(target) }),
    ).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);

    const start = await startMcpOAuthSignIn(target);
    expect(start.status).toBe("pending");

    const authorizationUrl = new URL(start.authorizationUrl!);
    expect(authorizationUrl.origin).toBe(as.url);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(mcpOAuthRedirectUrl());
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    // Dynamic client registration ran, against the public redirect URI.
    expect(as.registrationRequests).toHaveLength(1);

    const redirect = await fetch(start.authorizationUrl!, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    const callback = new URL(redirect.headers.get("location")!);
    const state = callback.searchParams.get("state")!;

    // Saale's callback resolves the server from the state it stored.
    expect(await resolveMcpOAuthState(state)).toEqual({ userId: USER_ID, serverId: SERVER_ID });

    await completeMcpOAuthSignIn(target, { code: callback.searchParams.get("code")! });
    await markMcpOAuthSignInSucceeded(USER_ID, SERVER_ID);

    expect(await hasMcpOAuthCredential(USER_ID, SERVER_ID)).toBe(true);
    expect((await readMcpOAuthFlow(USER_ID, SERVER_ID))?.status).toBe("succeeded");

    const provider = createMcpAuthProvider(target);
    expect(await provider.token()).toBe(as.accessToken);

    const result = await probeMcpServer({ url: target.url, authProvider: provider });
    expect(result.tools.map((tool) => tool.name)).toEqual(["HassTurnOn"]);
  });

  it("reports needs-auth before any sign-in is stored", async () => {
    await expect(
      probeMcpServer({ url: mcp.url, authProvider: createMcpAuthProvider(server()) }),
    ).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
    expect(await hasMcpOAuthCredential(USER_ID, SERVER_ID)).toBe(false);
  });

  it("refreshes the access token on a 401 without a new sign-in", async () => {
    await signIn();
    const before = as.tokenRequests.length;

    const provider = createMcpAuthProvider(server());
    const onUnauthorized = provider.onUnauthorized;
    if (!onUnauthorized) throw new Error("the OAuth provider must handle 401s");
    await onUnauthorized({
      response: new Response(null, { status: 401 }),
      serverUrl: new URL(mcp.url),
      fetch: globalThis.fetch,
      token: as.accessToken,
    });

    expect(as.tokenRequests.slice(before).map((request) => request.grant_type)).toContain(
      "refresh_token",
    );
    expect(await provider.token()).toBe(as.accessToken);
  });

  it("scopes credentials to their owner and clears them on sign out", async () => {
    await signIn();
    store.credentials.set("srv-2", {
      serverId: "srv-2",
      userId: "someone-else",
      serverUrl: "https://other.example/mcp",
      encryptedState: "irrelevant",
    });

    expect(await loadMcpOAuthCredentialIds(USER_ID, [SERVER_ID, "srv-2"])).toEqual(
      new Set([SERVER_ID]),
    );
    expect(await hasMcpOAuthCredential("someone-else", SERVER_ID)).toBe(false);

    await clearMcpOAuthCredential(USER_ID, SERVER_ID);
    expect(await hasMcpOAuthCredential(USER_ID, SERVER_ID)).toBe(false);
  });
});
