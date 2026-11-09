import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import {
  GithubApiError,
  createAppJwt,
  createInstallationToken,
  listInstallationRepositories,
  listInstallations,
  pollDeviceCode,
  readAppIdentity,
  readUserLogin,
  refreshUserTokens,
  requestDeviceCode,
} from "@/lib/integrations/github-app-client";

// ─── A real key pair, so the JWT is actually signed ──────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// GitHub's "Generate a private key" downloads PKCS#1, which is what an admin
// pastes; the PKCS#8 pair above is the other format this has to accept.
const pkcs1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const APP = { appId: "4711", privateKey };

/** A fixed clock, so the JWT claims are asserted by value. */
function now(): Date {
  return new Date("2026-03-01T12:00:00Z");
}

// ─── Fetch plumbing ─────────────────────────────────────────────────────────

interface Call {
  url: string;
  init: RequestInit | undefined;
}

let calls: Call[] = [];
let answer: { body: unknown; status?: number; raw?: string } = { body: {} };

function stubFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const status = answer.status ?? 200;
    const text = answer.raw ?? JSON.stringify(answer.body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  });
}

/** The form body one call sent, as a plain object. */
function sentForm(): Record<string, string> {
  const body = calls[0]?.init?.body;
  return Object.fromEntries(new URLSearchParams(String(body ?? "")));
}

/** The JSON body one call sent. */
function sentJson(): Record<string, unknown> {
  return JSON.parse(String(calls[0]?.init?.body ?? "{}")) as Record<string, unknown>;
}

function header(name: string): string | null {
  const headers = calls[0]?.init?.headers;
  return new Headers(headers as HeadersInit).get(name);
}

beforeEach(() => {
  calls = [];
  answer = { body: {} };
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── The app JWT ────────────────────────────────────────────────────────────

describe("createAppJwt", () => {
  it("signs a nine-minute token whose issuer is the app id", async () => {
    const now = new Date("2026-03-01T12:00:00Z");
    const jwt = await createAppJwt(APP, now);

    const verified = await jwtVerify(jwt, await importSPKI(publicKey, "RS256"), {
      currentDate: now,
    });
    expect(verified.protectedHeader.alg).toBe("RS256");
    expect(verified.payload.iss).toBe("4711");

    // Backdated a minute and capped at ten, so a clock on either side is safe.
    const issued = verified.payload.iat ?? 0;
    const expires = verified.payload.exp ?? 0;
    expect(expires - issued).toBe(600);
    expect(issued).toBe(Math.floor(now.getTime() / 1000) - 60);
  });

  it("refuses a key that is not a PEM private key", async () => {
    await expect(createAppJwt({ appId: "1", privateKey: "not a key" })).rejects.toBeInstanceOf(
      GithubApiError,
    );
  });

  it("signs with the PKCS#1 key GitHub hands out", async () => {
    expect(pkcs1.privateKey).toContain("BEGIN RSA PRIVATE KEY");

    const jwt = await createAppJwt({ appId: "4711", privateKey: pkcs1.privateKey }, now());
    const verified = await jwtVerify(jwt, await importSPKI(pkcs1.publicKey, "RS256"), {
      currentDate: now(),
    });

    expect(verified.payload.iss).toBe("4711");
  });

  it("accepts a key whose line breaks arrived as literal backslash-n", async () => {
    const flattened = pkcs1.privateKey.replace(/\n/g, "\\n");

    const jwt = await createAppJwt({ appId: "4711", privateKey: flattened }, now());
    await expect(
      jwtVerify(jwt, await importSPKI(pkcs1.publicKey, "RS256"), { currentDate: now() }),
    ).resolves.toBeTruthy();
  });
});

// ─── Device flow ────────────────────────────────────────────────────────────

describe("requestDeviceCode", () => {
  it("asks for a code with offline_access, so a refresh token comes back", async () => {
    answer = {
      body: {
        device_code: "device-123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      },
    };

    const code = await requestDeviceCode("client-abc");

    expect(calls[0]?.url).toBe("https://github.com/login/device/code");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(sentForm()).toEqual({ client_id: "client-abc", scope: "offline_access" });
    expect(header("accept")).toBe("application/json");
    expect(code).toEqual({
      deviceCode: "device-123",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
  });

  it("refuses an answer that carries no code", async () => {
    answer = { body: { error: "device_flow_disabled" } };
    await expect(requestDeviceCode("client-abc")).rejects.toBeInstanceOf(GithubApiError);
  });
});

describe("pollDeviceCode", () => {
  const poll = () => pollDeviceCode("client-abc", "device-123");

  it("sends the device-code grant", async () => {
    answer = { body: { error: "authorization_pending" } };
    await poll();

    expect(calls[0]?.url).toBe("https://github.com/login/oauth/access_token");
    expect(sentForm()).toEqual({
      client_id: "client-abc",
      device_code: "device-123",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  it("maps every state GitHub reports before a token", async () => {
    for (const [error, state] of [
      ["authorization_pending", "pending"],
      ["slow_down", "slow-down"],
      ["expired_token", "expired"],
      ["access_denied", "denied"],
    ] as const) {
      answer = { body: { error } };
      expect(await poll()).toEqual({ state });
    }
  });

  it("returns the token pair with the expiries GitHub states", async () => {
    answer = {
      body: {
        access_token: "ghu_access",
        refresh_token: "ghr_refresh",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
      },
    };

    const result = await poll();
    expect(result.state).toBe("authorized");
    if (result.state !== "authorized") return;

    expect(result.tokens.accessToken).toBe("ghu_access");
    expect(result.tokens.refreshToken).toBe("ghr_refresh");

    const accessIn = (result.tokens.accessExpiresAt?.getTime() ?? 0) - Date.now();
    expect(accessIn).toBeGreaterThan(28_700_000);
    expect(accessIn).toBeLessThanOrEqual(28_800_000);
    const refreshIn = (result.tokens.refreshExpiresAt?.getTime() ?? 0) - Date.now();
    expect(refreshIn).toBeGreaterThan(15_897_000_000);
  });

  it("leaves the expiries out when GitHub grants a token without them", async () => {
    answer = { body: { access_token: "ghu_forever" } };

    const result = await poll();
    expect(result.state).toBe("authorized");
    if (result.state !== "authorized") return;
    expect(result.tokens.accessExpiresAt).toBeNull();
    expect(result.tokens.refreshToken).toBeNull();
  });

  it("throws GitHub's reason for an error it does not know", async () => {
    answer = { body: { error: "device_flow_disabled", error_description: "Device flow off" } };

    await expect(poll()).rejects.toThrow(/Device flow off/);
  });
});

describe("refreshUserTokens", () => {
  it("sends the refresh grant with the client secret", async () => {
    answer = { body: { access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28_800 } };

    const tokens = await refreshUserTokens({
      clientId: "client-abc",
      clientSecret: "secret",
      refreshToken: "ghr_old",
    });

    expect(sentForm()).toEqual({
      client_id: "client-abc",
      client_secret: "secret",
      grant_type: "refresh_token",
      refresh_token: "ghr_old",
    });
    expect(tokens.accessToken).toBe("ghu_new");
    expect(tokens.refreshToken).toBe("ghr_new");
  });

  it("refuses when GitHub sends no token", async () => {
    answer = { body: { error: "bad_refresh_token", error_description: "Invalid refresh token" } };

    await expect(
      refreshUserTokens({ clientId: "c", clientSecret: "s", refreshToken: "r" }),
    ).rejects.toThrow(/Invalid refresh token/);
  });
});

// ─── Reading ────────────────────────────────────────────────────────────────

describe("readAppIdentity", () => {
  it("reads the slug, name, owner and permissions", async () => {
    answer = {
      body: {
        slug: "saale",
        name: "Saale",
        owner: { login: "askguenther" },
        permissions: { contents: "write", metadata: "read" },
      },
    };

    const identity = await readAppIdentity("jwt-1");

    expect(calls[0]?.url).toBe("https://api.github.com/app");
    expect(header("authorization")).toBe("Bearer jwt-1");
    expect(header("x-github-api-version")).toBe("2022-11-28");
    expect(identity).toEqual({
      slug: "saale",
      name: "Saale",
      ownerLogin: "askguenther",
      permissions: { contents: "write", metadata: "read" },
    });
  });
});

describe("readUserLogin", () => {
  it("reports the account behind the token", async () => {
    answer = { body: { login: "octocat" } };
    expect(await readUserLogin("ghu_1")).toBe("octocat");
  });
});

describe("listInstallations", () => {
  it("maps the installations the user can reach and skips broken rows", async () => {
    answer = {
      body: {
        installations: [
          {
            id: 1234,
            account: { login: "acme", type: "Organization" },
            repository_selection: "selected",
            permissions: { contents: "write" },
          },
          {
            id: 5678,
            account: { login: "octocat", type: "User" },
            repository_selection: "all",
            suspended_at: "2026-01-01T00:00:00Z",
          },
          { id: 99, account: {} },
        ],
      },
    };

    const installations = await listInstallations("ghu_1");

    expect(calls[0]?.url).toBe("https://api.github.com/user/installations?per_page=100");
    expect(installations).toEqual([
      {
        installationId: "1234",
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        permissions: { contents: "write" },
        suspended: false,
      },
      {
        installationId: "5678",
        accountLogin: "octocat",
        accountType: "User",
        repositorySelection: "all",
        permissions: null,
        suspended: true,
      },
    ]);
  });
});

describe("listInstallationRepositories", () => {
  it("returns the repository names of a selected installation", async () => {
    answer = { body: { repositories: [{ name: "api" }, { name: "web" }, {}] } };

    expect(await listInstallationRepositories("ghu_1", "1234")).toEqual(["api", "web"]);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/user/installations/1234/repositories?per_page=100",
    );
  });
});

// ─── Minting ────────────────────────────────────────────────────────────────

describe("createInstallationToken", () => {
  const mint = (scope?: Parameters<typeof createInstallationToken>[0]["scope"]) =>
    createInstallationToken({ jwt: "jwt-1", installationId: "1234", ...(scope ? { scope } : {}) });

  it("narrows the token to the repositories and permissions it is given", async () => {
    answer = { body: { token: "ghs_narrow", expires_at: "2026-03-01T13:00:00Z" } };

    const minted = await mint({
      repositories: ["saale"],
      permissions: { contents: "write", pull_requests: "write" },
    });

    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/1234/access_tokens");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(header("authorization")).toBe("Bearer jwt-1");
    expect(sentJson()).toEqual({
      repositories: ["saale"],
      permissions: { contents: "write", pull_requests: "write" },
    });
    expect(minted.token).toBe("ghs_narrow");
    expect(minted.expiresAt.toISOString()).toBe("2026-03-01T13:00:00.000Z");
  });

  it("asks for the installation's full rights when nothing narrows it", async () => {
    answer = { body: { token: "ghs_full", expires_at: "2026-03-01T13:00:00Z" } };

    await mint();

    expect(sentJson()).toEqual({});
  });

  it("reports GitHub's refusal with its status", async () => {
    answer = {
      status: 422,
      body: { message: "Repository not granted to this installation" },
    };

    await expect(mint({ repositories: ["elsewhere"] })).rejects.toMatchObject({
      name: "GithubApiError",
      status: 422,
      message: "Repository not granted to this installation",
    });
  });

  it("refuses an answer without a token", async () => {
    answer = { body: { expires_at: "2026-03-01T13:00:00Z" } };
    await expect(mint()).rejects.toBeInstanceOf(GithubApiError);
  });
});
