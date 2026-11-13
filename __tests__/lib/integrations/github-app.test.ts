process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Fakes: prisma, redis, crypto, and GitHub's answers ─────────────────────

const { db } = vi.hoisted(() => ({
  db: {
    githubApp: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    githubInstallation: { upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    githubInstallationAccess: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    githubUserToken: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/db", () => ({ prisma: db }));

const { redis, redisStore } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    redis: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      },
      del: async (key: string) => (store.delete(key) ? 1 : 0),
    },
  };
});

vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

// A reversible stand-in, so a test can see that what is stored is not plaintext.
vi.mock("@/lib/crypto", () => ({
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => value.replace(/^enc:/, ""),
}));

const client = vi.hoisted(() => ({
  createAppJwt: vi.fn(async () => "jwt-1"),
  readAppIdentity: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollDeviceCode: vi.fn(),
  refreshUserTokens: vi.fn(),
  readUserLogin: vi.fn(),
  listInstallations: vi.fn(),
  listInstallationRepositories: vi.fn(),
  listInstallationRepositoryRefs: vi.fn(),
  listRepositoryChoices: vi.fn(),
  addInstallationRepository: vi.fn(),
  removeInstallationRepository: vi.fn(),
  createInstallationToken: vi.fn(),
}));

vi.mock("@/lib/integrations/github-app-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/github-app-client")>();
  return { ...actual, ...client };
});

import { GithubApiError } from "@/lib/integrations/github-app-client";
import {
  GithubAppError,
  applyGithubRepositoryChoices,
  deleteGithubApp,
  githubInstallationForOwner,
  mintGithubInstallationToken,
  pollGithubAppLogin,
  readGithubRepositoryChoices,
  readGithubUserAccess,
  refreshGithubInstallations,
  saveGithubApp,
  signOutGithubApp,
  startGithubAppLogin,
  syncGithubInstallations,
} from "@/lib/integrations/github-app";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER = "user-1";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
const NOW = new Date("2026-05-01T12:00:00Z");

const APP_ROW = {
  id: "global",
  appId: "4711",
  clientId: "client-abc",
  encryptedClientSecret: "enc:secret",
  encryptedPrivateKey: `enc:${PEM}`,
  slug: "saale",
  name: "Saale",
  ownerLogin: "askguenther",
  permissions: { contents: "write" },
  enabled: true,
  updatedByUserId: "admin-1",
  createdAt: NOW,
  updatedAt: NOW,
};

/** An installation row as the client reports it. */
const INSTALLATION = {
  installationId: "1234",
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  permissions: { contents: "write" },
  suspended: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  redisStore.clear();
  for (const model of Object.values(db)) {
    for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  for (const fn of Object.values(client)) (fn as ReturnType<typeof vi.fn>).mockReset();

  db.githubApp.findUnique.mockResolvedValue(APP_ROW);
  db.githubApp.upsert.mockImplementation(async ({ create }: { create: object }) => ({
    ...APP_ROW,
    ...create,
  }));
  db.githubInstallationAccess.deleteMany.mockResolvedValue({ count: 0 });
  db.githubInstallationAccess.findMany.mockResolvedValue([]);
  db.githubUserToken.deleteMany.mockResolvedValue({ count: 0 });
  client.createAppJwt.mockResolvedValue("jwt-1");
  // The picker re-reads the app's permissions; an app of this age holds neither
  // of the installation ones unless a test says otherwise.
  client.readAppIdentity.mockResolvedValue({
    slug: "saale",
    name: "Saale",
    ownerLogin: "askguenther",
    permissions: { contents: "write" },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── Saving the app ─────────────────────────────────────────────────────────

describe("saveGithubApp", () => {
  const save = (overrides: Partial<Parameters<typeof saveGithubApp>[0]> = {}) =>
    saveGithubApp({
      appId: "4711",
      clientId: "client-abc",
      clientSecret: "secret",
      privateKey: PEM,
      adminUserId: "admin-1",
      ...overrides,
    });

  it("refuses input that cannot be an app before it calls GitHub", async () => {
    await expect(save({ appId: "saale" })).rejects.toThrow(/app id is a number/);
    await expect(save({ clientSecret: "  " })).rejects.toThrow(/client secret/);
    await expect(save({ privateKey: "not a key" })).rejects.toThrow(/PEM/);

    expect(client.readAppIdentity).not.toHaveBeenCalled();
    expect(db.githubApp.upsert).not.toHaveBeenCalled();
  });

  it("verifies the credentials with GitHub and stores them encrypted", async () => {
    client.readAppIdentity.mockResolvedValue({
      slug: "saale",
      name: "Saale",
      ownerLogin: "askguenther",
      permissions: { contents: "write" },
    });

    const summary = await save();

    expect(client.createAppJwt).toHaveBeenCalledWith({ appId: "4711", privateKey: PEM });
    expect(client.readAppIdentity).toHaveBeenCalledWith("jwt-1");
    expect(db.githubApp.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          appId: "4711",
          encryptedClientSecret: "enc:secret",
          encryptedPrivateKey: `enc:${PEM}`,
          slug: "saale",
          enabled: true,
          updatedByUserId: "admin-1",
        }),
      }),
    );
    expect(summary).toMatchObject({ slug: "saale", ownerLogin: "askguenther", enabled: true });
    // Nothing secret comes back out.
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("reports GitHub's refusal instead of storing unusable credentials", async () => {
    client.readAppIdentity.mockRejectedValue(
      new GithubApiError("A JSON web token could not be decoded", 401),
    );

    await expect(save()).rejects.toThrow(GithubAppError);
    await expect(save()).rejects.toThrow(/app id and the private key/);
    expect(db.githubApp.upsert).not.toHaveBeenCalled();
  });

  it("says the key is unreadable when the key is the problem, not GitHub", async () => {
    client.createAppJwt.mockRejectedValue(
      new GithubApiError("The GitHub App private key cannot be read", 0),
    );

    await expect(save()).rejects.toThrow(/private key could not be read/);
    expect(client.readAppIdentity).not.toHaveBeenCalled();
    expect(db.githubApp.upsert).not.toHaveBeenCalled();
  });
});

// ─── The sign-in ────────────────────────────────────────────────────────────

describe("startGithubAppLogin", () => {
  it("needs a configured app", async () => {
    db.githubApp.findUnique.mockResolvedValue(null);
    await expect(startGithubAppLogin(USER)).rejects.toThrow(/no GitHub App/);
  });

  it("stores the code in redis and hands it to the card", async () => {
    client.requestDeviceCode.mockResolvedValue({
      deviceCode: "device-123",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });

    const login = await startGithubAppLogin(USER);

    expect(login.userCode).toBe("WDJB-MJHT");
    expect(redisStore.get(`github-app-login:${USER}`)).toContain("device-123");
  });
});

describe("pollGithubAppLogin", () => {
  const startFlow = () => startGithubAppLogin(USER).catch(() => undefined);

  beforeEach(() => {
    client.requestDeviceCode.mockResolvedValue({
      deviceCode: "device-123",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
  });

  it("is idle when nothing is in flight", async () => {
    expect(await pollGithubAppLogin(USER)).toEqual({ state: "idle" });
    expect(client.pollDeviceCode).not.toHaveBeenCalled();
  });

  it("waits out the interval before asking GitHub", async () => {
    await startFlow();
    await pollGithubAppLogin(USER);
    expect(client.pollDeviceCode).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(NOW.getTime() + 6_000));
    client.pollDeviceCode.mockResolvedValue({ state: "pending" });
    await pollGithubAppLogin(USER);
    expect(client.pollDeviceCode).toHaveBeenCalledWith("client-abc", "device-123");
  });

  it("adds GitHub's five seconds on a slow_down", async () => {
    await startFlow();
    vi.setSystemTime(new Date(NOW.getTime() + 6_000));
    client.pollDeviceCode.mockResolvedValue({ state: "slow-down" });

    const answer = await pollGithubAppLogin(USER);
    expect(answer.state).toBe("slow-down");

    // The next poll is ten seconds out, not five.
    client.pollDeviceCode.mockClear();
    vi.setSystemTime(new Date(NOW.getTime() + 12_000));
    await pollGithubAppLogin(USER);
    expect(client.pollDeviceCode).not.toHaveBeenCalled();
  });

  it("stores the token, forgets the code and syncs the installations", async () => {
    await startFlow();
    vi.setSystemTime(new Date(NOW.getTime() + 6_000));
    client.pollDeviceCode.mockResolvedValue({
      state: "authorized",
      tokens: {
        accessToken: "ghu_access",
        refreshToken: "ghr_refresh",
        accessExpiresAt: new Date(NOW.getTime() + 8 * 60 * 60_000),
        refreshExpiresAt: new Date(NOW.getTime() + 180 * 24 * 60 * 60_000),
      },
    });
    client.readUserLogin.mockResolvedValue("octocat");
    client.listInstallations.mockResolvedValue([]);

    const answer = await pollGithubAppLogin(USER);

    expect(answer).toEqual({ state: "authorized", login: "octocat" });
    expect(db.githubUserToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          userId: USER,
          encryptedAccessToken: "enc:ghu_access",
          encryptedRefreshToken: "enc:ghr_refresh",
          login: "octocat",
        }),
      }),
    );
    expect(client.listInstallations).toHaveBeenCalledWith("ghu_access");
    expect(redisStore.has(`github-app-login:${USER}`)).toBe(false);
  });

  it("clears a code GitHub says has expired", async () => {
    await startFlow();
    vi.setSystemTime(new Date(NOW.getTime() + 6_000));
    client.pollDeviceCode.mockResolvedValue({ state: "expired" });

    expect(await pollGithubAppLogin(USER)).toEqual({ state: "expired" });
    expect(redisStore.has(`github-app-login:${USER}`)).toBe(false);
  });
});

// ─── The user's token ───────────────────────────────────────────────────────

describe("readGithubUserAccess", () => {
  const row = (expiresInMs: number) => ({
    userId: USER,
    encryptedAccessToken: "enc:ghu_access",
    encryptedRefreshToken: "enc:ghr_refresh",
    accessExpiresAt: new Date(Date.now() + expiresInMs),
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    login: "octocat",
  });

  it("returns the stored token while it is fresh", async () => {
    db.githubUserToken.findUnique.mockResolvedValue(row(4 * 60 * 60_000));

    expect(await readGithubUserAccess(USER)).toEqual({
      accessToken: "ghu_access",
      login: "octocat",
      expiresAt: expect.any(Date),
    });
    expect(client.refreshUserTokens).not.toHaveBeenCalled();
  });

  it("refreshes before the token runs out and keeps the pair", async () => {
    db.githubUserToken.findUnique.mockResolvedValue(row(60_000));
    client.refreshUserTokens.mockResolvedValue({
      accessToken: "ghu_new",
      refreshToken: "ghr_new",
      accessExpiresAt: new Date(Date.now() + 8 * 60 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60_000),
    });

    const access = await readGithubUserAccess(USER);

    expect(client.refreshUserTokens).toHaveBeenCalledWith({
      clientId: "client-abc",
      clientSecret: "secret",
      refreshToken: "ghr_refresh",
    });
    expect(access?.accessToken).toBe("ghu_new");
    expect(db.githubUserToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ encryptedAccessToken: "enc:ghu_new", login: "octocat" }),
      }),
    );
  });

  it("forgets a token GitHub will not refresh", async () => {
    db.githubUserToken.findUnique.mockResolvedValue(row(60_000));
    client.refreshUserTokens.mockRejectedValue(new GithubApiError("Bad credentials", 401));

    expect(await readGithubUserAccess(USER)).toBeNull();
    expect(db.githubUserToken.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it("is null without a stored token", async () => {
    db.githubUserToken.findUnique.mockResolvedValue(null);
    expect(await readGithubUserAccess(USER)).toBeNull();
  });
});

// ─── Installations ──────────────────────────────────────────────────────────

describe("syncGithubInstallations", () => {
  it("upserts what GitHub lists and drops access the account lost", async () => {
    db.githubUserToken.findUnique.mockResolvedValue({
      userId: USER,
      encryptedAccessToken: "enc:ghu_access",
      encryptedRefreshToken: "enc:ghr",
      accessExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      login: "octocat",
    });
    client.listInstallations.mockResolvedValue([INSTALLATION]);
    client.listInstallationRepositories.mockResolvedValue(["saale", "web"]);
    db.githubInstallation.upsert.mockResolvedValue({ id: "row-1" });

    await syncGithubInstallations(USER);

    expect(client.listInstallationRepositories).toHaveBeenCalledWith("ghu_access", "1234");
    expect(db.githubInstallation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installationId: "1234" },
        create: expect.objectContaining({
          accountLogin: "acme",
          repositorySelection: "selected",
          repositories: ["saale", "web"],
        }),
      }),
    );
    expect(db.githubInstallationAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_installationId: { userId: USER, installationId: "row-1" } },
      }),
    );
    expect(db.githubInstallationAccess.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, installationId: { notIn: ["row-1"] } },
    });
  });

  it("spends the repository budget on reads, not on installations walked", async () => {
    db.githubUserToken.findUnique.mockResolvedValue({
      userId: USER,
      encryptedAccessToken: "enc:ghu_access",
      encryptedRefreshToken: "enc:ghr",
      accessExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      login: "octocat",
    });
    // An account with many "all repositories" installs would have used up a cap
    // that counted installations, and the one that needs its list read would be
    // skipped — which is why the counter follows the reads.
    const grantedEverything = Array.from({ length: 50 }, (_, index) => ({
      installationId: `${1000 + index}`,
      accountLogin: `acct-${index}`,
      accountType: "Organization",
      repositorySelection: "all",
      permissions: null,
      suspended: false,
    }));
    client.listInstallations.mockResolvedValue([
      ...grantedEverything,
      { ...INSTALLATION, installationId: "1234" },
    ]);
    client.listInstallationRepositories.mockResolvedValue(["saale"]);
    db.githubInstallation.upsert.mockResolvedValue({ id: "row-1" });

    await syncGithubInstallations(USER);

    expect(client.listInstallationRepositories).toHaveBeenCalledTimes(1);
    expect(client.listInstallationRepositories).toHaveBeenCalledWith("ghu_access", "1234");
  });

  it("does not list repositories of an installation granted everything", async () => {
    db.githubUserToken.findUnique.mockResolvedValue({
      userId: USER,
      encryptedAccessToken: "enc:ghu_access",
      encryptedRefreshToken: "enc:ghr",
      accessExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      login: "octocat",
    });
    client.listInstallations.mockResolvedValue([{ ...INSTALLATION, repositorySelection: "all" }]);
    db.githubInstallation.upsert.mockResolvedValue({ id: "row-1" });

    await syncGithubInstallations(USER);

    expect(client.listInstallationRepositories).not.toHaveBeenCalled();
  });
});

describe("readGithubRepositoryChoices", () => {
  const accessRow = (suspended = false) => ({
    userId: USER,
    installationId: "row-1",
    installation: {
      id: "row-1",
      installationId: "1234",
      accountLogin: "Acme",
      accountType: "Organization",
      repositorySelection: "selected",
      repositories: ["saale"],
      suspendedAt: suspended ? new Date() : null,
    },
  });

  const freshToken = () => ({
    userId: USER,
    encryptedAccessToken: "enc:ghu_access",
    encryptedRefreshToken: "enc:ghr",
    accessExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    login: "octocat",
  });

  it("finds the installation by GitHub's id, which is what the card sends", async () => {
    db.githubInstallationAccess.findFirst.mockResolvedValue(accessRow());
    db.githubUserToken.findUnique.mockResolvedValue(freshToken());
    client.listInstallationRepositoryRefs.mockResolvedValue([
      { id: "10", name: "saale", fullName: "acme/saale" },
    ]);
    client.listRepositoryChoices.mockResolvedValue([
      { id: "10", name: "saale", fullName: "acme/saale", owner: "acme", canAdmin: true },
      { id: "11", name: "site", fullName: "acme/site", owner: "acme", canAdmin: true },
      // Read-only, and another account's: neither can be added here.
      { id: "12", name: "docs", fullName: "acme/docs", owner: "acme", canAdmin: false },
      { id: "13", name: "other", fullName: "elsewhere/other", owner: "elsewhere", canAdmin: true },
    ]);

    const choices = await readGithubRepositoryChoices(USER, "1234");

    expect(db.githubInstallationAccess.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, installation: { installationId: "1234" } },
      }),
    );
    expect(choices).toMatchObject({
      installationId: "1234",
      accountLogin: "Acme",
      selection: "selected",
      canManage: true,
    });
    expect(choices.candidates.map((entry) => entry.id)).toEqual(["10", "11"]);
  });

  it("refuses an installation another account holds", async () => {
    db.githubInstallationAccess.findFirst.mockResolvedValue(null);

    await expect(readGithubRepositoryChoices(USER, "1234")).rejects.toThrow(/no access/);
    expect(client.listRepositoryChoices).not.toHaveBeenCalled();
  });

  it("refuses a suspended installation", async () => {
    db.githubInstallationAccess.findFirst.mockResolvedValue(accessRow(true));

    await expect(readGithubRepositoryChoices(USER, "1234")).rejects.toThrow(/suspended/);
  });
});

describe("applyGithubRepositoryChoices", () => {
  const accessRow = (selection = "selected") => ({
    userId: USER,
    installationId: "row-1",
    installation: {
      id: "row-1",
      installationId: "1234",
      accountLogin: "Acme",
      accountType: "Organization",
      repositorySelection: selection,
      repositories: ["saale"],
      suspendedAt: null,
    },
  });

  const freshToken = () => ({
    userId: USER,
    encryptedAccessToken: "enc:ghu_access",
    encryptedRefreshToken: "enc:ghr",
    accessExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
    refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    login: "octocat",
  });

  const ready = (permissions: Record<string, string> | null, selection = "selected") => {
    db.githubInstallationAccess.findFirst.mockResolvedValue(accessRow(selection));
    db.githubUserToken.findUnique.mockResolvedValue(freshToken());
    client.readAppIdentity.mockResolvedValue({
      slug: "saale",
      name: "Saale",
      ownerLogin: "askguenther",
      permissions,
    });
    client.listInstallationRepositoryRefs.mockResolvedValue([
      { id: "10", name: "saale", fullName: "acme/saale" },
    ]);
  };

  it("names the missing permission instead of calling GitHub", async () => {
    ready({ contents: "write", pull_requests: "write" });

    const error = await applyGithubRepositoryChoices(USER, "1234", ["10", "11"]).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(GithubAppError);
    expect((error as Error).message).toMatch(/installation repository access/);
    expect(client.addInstallationRepository).not.toHaveBeenCalled();
    expect(client.removeInstallationRepository).not.toHaveBeenCalled();
  });

  it("turns GitHub's 403 on those two calls into that same sentence", async () => {
    // The permission is there, so the early check passes and GitHub is the one
    // that refuses: an installation the app may read but not change.
    ready({ contents: "write", installation_repositories: "write" });
    client.addInstallationRepository.mockRejectedValue(
      new GithubApiError("Resource not accessible by integration", 403),
    );

    const error = await applyGithubRepositoryChoices(USER, "1234", ["10", "11"]).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(GithubAppError);
    expect((error as Error).message).toMatch(/installation repository access/);
    expect((error as Error).message).not.toMatch(/Resource not accessible/);
  });

  it("passes another refusal through as it is", async () => {
    ready({ contents: "write", installation_repositories: "write" });
    client.addInstallationRepository.mockRejectedValue(new GithubApiError("Not Found", 404));

    const error = await applyGithubRepositoryChoices(USER, "1234", ["10", "11"]).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(GithubApiError);
    expect((error as Error).message).toBe("Not Found");
  });

  it("still refuses an installation that covers everything before any of that", async () => {
    ready({ contents: "write", installation_repositories: "write" }, "all");

    await expect(applyGithubRepositoryChoices(USER, "1234", ["10"])).rejects.toThrow(
      /covers all repositories/,
    );
    expect(client.addInstallationRepository).not.toHaveBeenCalled();
  });

  it("sends only the difference, and stores what GitHub reports afterwards", async () => {
    ready({ contents: "write", installation_repositories: "write" });
    // Before, between, and after the two calls: GitHub reports the new set.
    client.listInstallationRepositoryRefs
      .mockResolvedValueOnce([{ id: "10", name: "saale", fullName: "acme/saale" }])
      .mockResolvedValue([
        { id: "10", name: "saale", fullName: "acme/saale" },
        { id: "11", name: "web", fullName: "acme/web" },
      ]);
    db.githubInstallationAccess.findFirst.mockResolvedValue(accessRow());
    client.listRepositoryChoices.mockResolvedValue([]);

    await applyGithubRepositoryChoices(USER, "1234", ["10", "11"]);

    expect(client.addInstallationRepository).toHaveBeenCalledWith("ghu_access", "1234", "11");
    expect(client.removeInstallationRepository).not.toHaveBeenCalled();
    expect(db.githubInstallation.update).toHaveBeenCalledWith({
      where: { id: "row-1" },
      data: { repositories: ["saale", "web"] },
    });
  });
});

describe("githubInstallationForOwner", () => {
  it("matches the account name case-insensitively and skips suspended ones", async () => {
    db.githubInstallationAccess.findFirst.mockResolvedValue({
      installation: {
        id: "row-1",
        installationId: "1234",
        accountLogin: "Acme",
        accountType: "Organization",
        repositorySelection: "selected",
        repositories: ["saale"],
        suspendedAt: null,
      },
    });

    const found = await githubInstallationForOwner(USER, "acme");
    expect(found?.installationId).toBe("1234");
    // The internal row id travels along, so the caller mints without a second read.
    expect(found?.rowId).toBe("row-1");
    expect(db.githubInstallationAccess.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER,
          installation: expect.objectContaining({
            accountLogin: { equals: "acme", mode: "insensitive" },
          }),
        }),
      }),
    );

    db.githubInstallationAccess.findFirst.mockResolvedValue(null);
    expect(await githubInstallationForOwner(USER, "acme-labs")).toBeNull();
    expect(await githubInstallationForOwner(USER, "  ")).toBeNull();
  });
});

// ─── Minting ────────────────────────────────────────────────────────────────

describe("mintGithubInstallationToken", () => {
  const accessRow = (suspended: boolean) => ({
    userId: USER,
    installationId: "row-1",
    installation: {
      installationId: "1234",
      accountLogin: "acme",
      suspendedAt: suspended ? new Date() : null,
    },
  });

  it("refuses an installation the account has no access to", async () => {
    db.githubInstallationAccess.findUnique.mockResolvedValue(null);

    await expect(
      mintGithubInstallationToken({ userId: USER, installationId: "row-2" }),
    ).rejects.toThrow(/no access/);
    expect(client.createInstallationToken).not.toHaveBeenCalled();
  });

  it("refuses a suspended installation", async () => {
    db.githubInstallationAccess.findUnique.mockResolvedValue(accessRow(true));

    await expect(
      mintGithubInstallationToken({ userId: USER, installationId: "row-1" }),
    ).rejects.toThrow(/suspended/);
  });

  it("narrows the token and caches it for the next call", async () => {
    db.githubInstallationAccess.findUnique.mockResolvedValue(accessRow(false));
    client.createInstallationToken.mockResolvedValue({
      token: "ghs_narrow",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    const scope = { repositories: ["saale"], permissions: { contents: "write" as const } };
    const first = await mintGithubInstallationToken({
      userId: USER,
      installationId: "row-1",
      scope,
    });
    const second = await mintGithubInstallationToken({
      userId: USER,
      installationId: "row-1",
      scope,
    });

    expect(client.createInstallationToken).toHaveBeenCalledTimes(1);
    expect(client.createInstallationToken).toHaveBeenCalledWith({
      jwt: "jwt-1",
      installationId: "1234",
      scope: { repositories: ["saale"], permissions: { contents: "write" } },
    });
    expect(second.token).toBe(first.token);
    expect(first.token).toBe("ghs_narrow");
  });

  it("keeps a differently scoped token apart from the cached one", async () => {
    db.githubInstallationAccess.findUnique.mockResolvedValue(accessRow(false));
    client.createInstallationToken.mockResolvedValue({
      token: "ghs_other",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    await mintGithubInstallationToken({
      userId: USER,
      installationId: "row-1",
      scope: { repositories: ["saale"] },
    });
    await mintGithubInstallationToken({
      userId: USER,
      installationId: "row-1",
      scope: { repositories: ["web"] },
    });

    expect(client.createInstallationToken).toHaveBeenCalledTimes(2);
  });
});

// ─── Forgetting ─────────────────────────────────────────────────────────────

describe("signOut and delete", () => {
  it("signing out drops the token and this account's access, not the installations", async () => {
    await signOutGithubApp(USER);

    expect(db.githubUserToken.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
    expect(db.githubInstallationAccess.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER },
    });
    expect(db.githubInstallation.deleteMany).not.toHaveBeenCalled();
  });

  it("deleting the app drops everything that depended on it", async () => {
    await deleteGithubApp();

    expect(db.githubUserToken.deleteMany).toHaveBeenCalled();
    expect(db.githubInstallationAccess.deleteMany).toHaveBeenCalled();
    expect(db.githubInstallation.deleteMany).toHaveBeenCalled();
    expect(db.githubApp.deleteMany).toHaveBeenCalledWith({ where: { id: "global" } });
  });
});

// ─── Refreshing what GitHub says ────────────────────────────────────────────

describe("refreshGithubInstallations", () => {
  it("asks GitHub once, then trusts the answer for a minute", async () => {
    db.githubUserToken.findUnique.mockResolvedValue({
      userId: USER,
      encryptedAccessToken: "enc:ghu_access",
      encryptedRefreshToken: "enc:ghr",
      accessExpiresAt: new Date(Date.now() + 4 * 60 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      login: "octocat",
    });
    client.listInstallations.mockResolvedValue([]);

    await refreshGithubInstallations(USER);
    await refreshGithubInstallations(USER);

    expect(client.listInstallations).toHaveBeenCalledTimes(1);
  });
});
