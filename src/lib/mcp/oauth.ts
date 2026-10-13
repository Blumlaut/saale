/**
 * OAuth 2.1 for a user's MCP servers.
 *
 * A remote MCP server that answers 401 with a bearer challenge wants an OAuth
 * sign-in. The agent session cannot start a browser, so the split is:
 *
 * - **Credentials** live in `McpOAuthCredential`, one encrypted blob per server
 *   (Pi's `McpOAuthState`: client registration, tokens, PKCE state, discovery).
 *   Pi's own store is a host-wide `mcp-auth.json`, which belongs to the machine's
 *   Pi install and every tenant at once, so Saale supplies its own store instead.
 * - **The session** authenticates through Pi's `AuthProvider`, which sends the
 *   stored token and refreshes it on a 401. When it cannot (no refresh token, or
 *   a rotated-away grant) it throws `McpOAuthAuthorizationRequiredError`, which
 *   the MCP extension reports as `needs-auth`.
 * - **The sign-in** runs here, driven by the settings page: Pi performs discovery
 *   and dynamic client registration, and the browser is sent to the authorization
 *   endpoint. The provider redirects back to *Saale's public URL*
 *   (`<public url>/api/mcp/oauth/callback`), not a loopback port, because the
 *   user's browser cannot reach the server host's loopback interface.
 *
 * `authorizeMcp` and `McpOAuthProvider` are Pi's, so anything Pi learns about
 * OAuth (a new registration method, a discovery fix) applies here unchanged.
 */

import { randomUUID } from "node:crypto";
import { McpAuthRequiredError, type AuthProvider, type McpFetch } from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  parseWwwAuthenticate,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import { decrypt, encrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { getPublicUrl } from "@/lib/public-url";
import { getRedis } from "@/lib/redis";

/** How long a sign-in may wait for the user before its browser state is dropped. */
const FLOW_TTL_SECONDS = 15 * 60;

/** How long a server's last OAuth challenge is kept, to guide the next sign-in. */
const CHALLENGE_TTL_SECONDS = 60 * 60;

/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;

/** Bound on the refresh lock wait, so a stuck refresher cannot hang a request. */
const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_MS = 100;

/** The database fields OAuth needs of a server. */
export interface McpOAuthServer {
  id: string;
  userId: string;
  name: string;
  url: string;
}

/** What a server's last 401 asked for, reused when the user signs in. */
export interface McpOAuthChallengeInfo {
  resourceMetadataUrl: string | null;
  scope: string | null;
}

/** The browser-facing state of a server's sign-in. */
export interface McpOAuthFlow {
  status: "pending" | "succeeded" | "failed";
  error: string | null;
  authorizationUrl: string | null;
}

/** The stored flow, which also carries what the callback needs to finish. */
interface StoredMcpOAuthFlow extends McpOAuthFlow {
  userId: string;
  serverId: string;
  scope: string | null;
  resourceMetadataUrl: string | null;
  updatedAt: string;
}

/** Redirect URI an authorization server sends the browser back to. */
export function mcpOAuthRedirectUrl(): string {
  return `${getPublicUrl()}/api/mcp/oauth/callback`;
}

/**
 * Pi's OAuth state for one server, encrypted at rest.
 *
 * Pi calls `save` for every change (discovery, PKCE verifier, tokens), so the
 * write path is a plain upsert; Pi serialises its own updates per provider.
 */
function createOAuthStateStore(server: McpOAuthServer): McpOAuthStateStore {
  return {
    async load() {
      const row = await prisma.mcpOAuthCredential.findUnique({
        where: { serverId: server.id },
      });
      if (!row || row.userId !== server.userId) return undefined;
      try {
        return JSON.parse(decrypt(row.encryptedState)) as McpOAuthState;
      } catch (err) {
        console.error(
          `Failed to read the stored OAuth state for MCP server "${server.name}":`,
          err,
        );
        return undefined;
      }
    },
    async save(state) {
      const encryptedState = encrypt(JSON.stringify(state));
      await prisma.mcpOAuthCredential.upsert({
        where: { serverId: server.id },
        create: {
          serverId: server.id,
          userId: server.userId,
          serverUrl: server.url,
          encryptedState,
        },
        update: { userId: server.userId, serverUrl: server.url, encryptedState },
      });
    },
  };
}

/** Pi's OAuth client for one server, against Saale's public redirect URI. */
function createOAuthClientProvider(
  server: McpOAuthServer,
  onRedirect: (url: URL) => void,
): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl: server.url,
    redirectUrl: mcpOAuthRedirectUrl(),
    clientMetadata: { client_name: "Saale" },
    store: createOAuthStateStore(server),
    onRedirect,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while no other process refreshes this server's tokens.
 *
 * Refresh tokens often rotate: two refreshes that both send the old token lose
 * the grant. The lock is best-effort — a refusal only lets two refreshes
 * overlap, which the store's own "token changed meanwhile" check usually saves.
 */
async function withRefreshLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const key = `mcp-oauth-refresh:${serverId}`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TTL_MS;
  let held = false;

  try {
    while (Date.now() < deadline) {
      if ((await redis.set(key, token, "PX", LOCK_TTL_MS, "NX")) === "OK") {
        held = true;
        break;
      }
      await delay(LOCK_RETRY_MS);
    }
  } catch (err) {
    console.error(`Failed to take the MCP OAuth refresh lock for server ${serverId}:`, err);
  }

  try {
    return await fn();
  } finally {
    if (held) {
      await redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          key,
          token,
        )
        .catch((err) =>
          console.error(
            `Failed to release the MCP OAuth refresh lock for server ${serverId}:`,
            err,
          ),
        );
    }
  }
}

function challengeKey(serverId: string): string {
  return `mcp-oauth-challenge:${serverId}`;
}

function flowKey(serverId: string): string {
  return `mcp-oauth-flow:${serverId}`;
}

function stateKey(state: string): string {
  return `mcp-oauth-state:${state}`;
}

/** Remember what a server's 401 asked for, so the next sign-in can reuse it. */
export async function rememberMcpOAuthChallenge(
  serverId: string,
  challenge: McpOAuthChallengeInfo,
): Promise<void> {
  await getRedis().set(
    challengeKey(serverId),
    JSON.stringify(challenge),
    "EX",
    CHALLENGE_TTL_SECONDS,
  );
}

async function readMcpOAuthChallenge(serverId: string): Promise<McpOAuthChallengeInfo | null> {
  try {
    const raw = await getRedis().get(challengeKey(serverId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as McpOAuthChallengeInfo;
    return {
      resourceMetadataUrl: parsed.resourceMetadataUrl ?? null,
      scope: parsed.scope ?? null,
    };
  } catch (err) {
    console.error(`Failed to read the OAuth challenge for MCP server ${serverId}:`, err);
    return null;
  }
}

/**
 * Remember the OAuth challenge an MCP client error carries.
 *
 * A server that reports its sign-in requirements in `WWW-Authenticate` may name
 * a resource metadata URL the default discovery would miss, so the challenge is
 * kept for the next sign-in.
 */
export async function cacheMcpOAuthChallenge(serverId: string, err: unknown): Promise<void> {
  if (!(err instanceof McpAuthRequiredError) || !err.wwwAuthenticate) return;
  if (!/resource_metadata=/i.test(err.wwwAuthenticate)) return;

  const challenge = parseWwwAuthenticate(err.wwwAuthenticate);
  if (!challenge.resourceMetadataUrl && !challenge.scope) return;

  await rememberMcpOAuthChallenge(serverId, {
    resourceMetadataUrl: challenge.resourceMetadataUrl?.href ?? null,
    scope: challenge.scope ?? null,
  });
}

/**
 * The bearer token to send, refreshed when it is about to expire and the
 * server gave us a refresh token. Report an interactive sign-in as
 * `McpOAuthAuthorizationRequiredError`, which the MCP extension turns into
 * `needs-auth` rather than a failed server.
 */
export function createMcpAuthProvider(server: McpOAuthServer): AuthProvider {
  const store = createOAuthStateStore(server);
  let refreshing: Promise<void> | undefined;

  const refresh = (
    staleToken: string | undefined,
    fetch?: McpFetch,
    challenge?: OAuthChallenge,
  ): Promise<void> => {
    refreshing ??= withRefreshLock(server.id, async () => {
      const state = await store.load();

      // Another process (or a fresh sign-in) already replaced the token.
      if (state?.tokens?.access_token !== staleToken) return;
      if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();

      const cached = await readMcpOAuthChallenge(server.id);
      const resourceMetadataUrl = challenge?.resourceMetadataUrl ?? cached?.resourceMetadataUrl;
      const scope = challenge?.scope;

      const provider = createOAuthClientProvider(server, () => {});
      const result = await authorizeMcp(provider, {
        serverUrl: server.url,
        ...(resourceMetadataUrl ? { resourceMetadataUrl: new URL(resourceMetadataUrl) } : {}),
        ...(scope ? { scope } : {}),
        ...(fetch ? { fetch } : {}),
      });
      if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
    }).finally(() => {
      refreshing = undefined;
    });

    return refreshing;
  };

  return {
    async token() {
      // A refresh already running may be about to store the token we want.
      await refreshing?.catch(() => {});

      const state = await store.load();
      const token = state?.tokens?.access_token;
      const expired =
        state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
      if (!expired || !state?.tokens?.refresh_token) return token;

      // A failed refresh falls through: the request goes out with the old token
      // and its 401 decides whether a sign-in is required.
      await refresh(token).catch((err) => {
        console.error(`Failed to refresh the MCP OAuth token for "${server.name}":`, err);
      });
      return (await store.load())?.tokens?.access_token;
    },

    async onUnauthorized(context) {
      const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));

      if (challenge.resourceMetadataUrl || challenge.scope) {
        await rememberMcpOAuthChallenge(server.id, {
          resourceMetadataUrl: challenge.resourceMetadataUrl?.href ?? null,
          scope: challenge.scope ?? null,
        }).catch((err) => {
          console.error(`Failed to store the OAuth challenge for "${server.name}":`, err);
        });
      }

      // A refresh keeps the granted scope, so a server asking for more needs a
      // new sign-in rather than a silent retry.
      if (challenge.error === "insufficient_scope") {
        throw new McpOAuthAuthorizationRequiredError();
      }

      await refresh(context.token, context.fetch, challenge);
    },
  };
}

/** Whether a server has stored OAuth credentials, for the settings list. */
export async function loadMcpOAuthCredentialIds(
  userId: string,
  serverIds: string[],
): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set();
  const rows = await prisma.mcpOAuthCredential.findMany({
    where: { userId, serverId: { in: serverIds } },
    select: { serverId: true },
  });
  return new Set(rows.map((row) => row.serverId));
}

/** Whether one server has stored OAuth credentials. */
export async function hasMcpOAuthCredential(userId: string, serverId: string): Promise<boolean> {
  const row = await prisma.mcpOAuthCredential.findFirst({
    where: { serverId, userId },
    select: { serverId: true },
  });
  return row !== null;
}

/** Drop a server's OAuth credentials (sign out, or a replaced endpoint). */
export async function clearMcpOAuthCredential(userId: string, serverId: string): Promise<void> {
  await prisma.mcpOAuthCredential.deleteMany({ where: { serverId, userId } });
}

function toPublicFlow(flow: StoredMcpOAuthFlow): McpOAuthFlow {
  return {
    status: flow.status,
    error: flow.error,
    authorizationUrl: flow.authorizationUrl,
  };
}

async function writeFlow(flow: StoredMcpOAuthFlow): Promise<void> {
  try {
    await getRedis().set(flowKey(flow.serverId), JSON.stringify(flow), "EX", FLOW_TTL_SECONDS);
  } catch (err) {
    console.error(`Failed to store the MCP OAuth flow for server ${flow.serverId}:`, err);
  }
}

/** The state of a server's sign-in, readable only by its owner. */
export async function readMcpOAuthFlow(
  userId: string,
  serverId: string,
): Promise<McpOAuthFlow | null> {
  const stored = await readStoredFlow(serverId);
  if (!stored || stored.userId !== userId) return null;
  return toPublicFlow(stored);
}

async function readStoredFlow(serverId: string): Promise<StoredMcpOAuthFlow | null> {
  try {
    const raw = await getRedis().get(flowKey(serverId));
    if (!raw) return null;
    return JSON.parse(raw) as StoredMcpOAuthFlow;
  } catch (err) {
    console.error(`Failed to read the MCP OAuth flow for server ${serverId}:`, err);
    return null;
  }
}

/** Forget a server's sign-in (started over, signed out, or completed). */
export async function clearMcpOAuthFlow(serverId: string): Promise<void> {
  await getRedis()
    .del(flowKey(serverId))
    .catch((err) => console.error(`Failed to clear the MCP OAuth flow for ${serverId}:`, err));
}

/** Map the `state` in a callback to the server that is signing in. */
export async function resolveMcpOAuthState(
  state: string,
): Promise<{ userId: string; serverId: string } | null> {
  try {
    const raw = await getRedis().get(stateKey(state));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { userId: string; serverId: string };
    if (!parsed.userId || !parsed.serverId) return null;
    return parsed;
  } catch (err) {
    console.error("Failed to resolve an MCP OAuth callback state:", err);
    return null;
  }
}

/** Drop the one-time `state` a callback was resolved with. */
export async function clearMcpOAuthState(state: string): Promise<void> {
  await getRedis()
    .del(stateKey(state))
    .catch((err) => console.error("Failed to clear an MCP OAuth callback state:", err));
}

export interface McpOAuthStartResult {
  /** `succeeded` when the stored refresh token was still good and no browser is needed. */
  status: "pending" | "succeeded";
  authorizationUrl: string | null;
}

/**
 * Begin a sign-in: discover the authorization server, register a client when
 * needed, and produce the URL the user's browser must open.
 *
 * A server whose grant is still refreshable is completed here instead — the
 * same rule Pi's CLI applies to `/mcp` sign-in.
 */
export async function startMcpOAuthSignIn(server: McpOAuthServer): Promise<McpOAuthStartResult> {
  const challenge = await readMcpOAuthChallenge(server.id);
  const scope = challenge?.scope ?? null;

  let authorizationUrl: string | null = null;
  const provider = createOAuthClientProvider(server, (url) => {
    authorizationUrl = url.href;
  });

  // Persist the CSRF state before the browser leaves, so the callback can find
  // this server even after a reload or a different Saale process.
  const state = await provider.state();
  await getRedis().set(
    stateKey(state),
    JSON.stringify({ userId: server.userId, serverId: server.id }),
    "EX",
    FLOW_TTL_SECONDS,
  );

  try {
    const result = await authorizeMcp(provider, {
      serverUrl: server.url,
      ...(challenge?.resourceMetadataUrl
        ? { resourceMetadataUrl: new URL(challenge.resourceMetadataUrl) }
        : {}),
      ...(scope ? { scope } : {}),
    });

    if (result === "AUTHORIZED") {
      const flow: StoredMcpOAuthFlow = {
        userId: server.userId,
        serverId: server.id,
        status: "succeeded",
        error: null,
        authorizationUrl: null,
        scope,
        resourceMetadataUrl: challenge?.resourceMetadataUrl ?? null,
        updatedAt: new Date().toISOString(),
      };
      await writeFlow(flow);
      return { status: "succeeded", authorizationUrl: null };
    }

    if (!authorizationUrl) {
      throw new Error("The authorization server did not return a sign-in URL");
    }

    const flow: StoredMcpOAuthFlow = {
      userId: server.userId,
      serverId: server.id,
      status: "pending",
      error: null,
      authorizationUrl,
      scope,
      resourceMetadataUrl: challenge?.resourceMetadataUrl ?? null,
      updatedAt: new Date().toISOString(),
    };
    await writeFlow(flow);
    return { status: "pending", authorizationUrl };
  } catch (err) {
    await clearMcpOAuthState(state);
    throw err;
  }
}

/**
 * Finish a sign-in with the code the browser carried back. Pi exchanges it for
 * tokens (PKCE) against the discovery state the start step persisted.
 */
export async function completeMcpOAuthSignIn(
  server: McpOAuthServer,
  params: { code: string; iss?: string },
): Promise<void> {
  const started = await readStoredFlow(server.id);
  const provider = createOAuthClientProvider(server, () => {});
  const result = await authorizeMcp(provider, {
    serverUrl: server.url,
    authorizationCode: params.code,
    ...(params.iss ? { iss: params.iss } : {}),
    ...(started?.scope ? { scope: started.scope } : {}),
    ...(started?.resourceMetadataUrl
      ? { resourceMetadataUrl: new URL(started.resourceMetadataUrl) }
      : {}),
  });

  if (result !== "AUTHORIZED") {
    throw new Error("The authorization server did not issue a token");
  }
}

/** Record that a sign-in completed, for the polling settings page. */
export async function markMcpOAuthSignInSucceeded(userId: string, serverId: string): Promise<void> {
  const started = await readStoredFlow(serverId);
  const flow: StoredMcpOAuthFlow = {
    userId,
    serverId,
    status: "succeeded",
    error: null,
    authorizationUrl: null,
    scope: started?.scope ?? null,
    resourceMetadataUrl: started?.resourceMetadataUrl ?? null,
    updatedAt: new Date().toISOString(),
  };
  await writeFlow(flow);
}

/** Mark a sign-in failed, so a polling settings page learns why. */
export async function failMcpOAuthSignIn(
  userId: string,
  serverId: string,
  error: string,
): Promise<void> {
  const existing = await readStoredFlow(serverId);
  const flow: StoredMcpOAuthFlow = {
    userId,
    serverId,
    status: "failed",
    error,
    authorizationUrl: null,
    scope: existing?.scope ?? null,
    resourceMetadataUrl: existing?.resourceMetadataUrl ?? null,
    updatedAt: new Date().toISOString(),
  };
  await writeFlow(flow);
}
