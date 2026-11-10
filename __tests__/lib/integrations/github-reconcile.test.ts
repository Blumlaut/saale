import { beforeEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({ githubCliLogin: vi.fn() }));
vi.mock("@/lib/coder/github", () => cli);

const settings = vi.hoisted(() => ({ ensureAdminSettings: vi.fn(), setSetting: vi.fn() }));
vi.mock("@/lib/settings/update", () => settings);

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
    },
  };
});
vi.mock("@/lib/redis", () => ({ getRedis: () => redis }));

const app = vi.hoisted(() => {
  class GithubAppError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "GithubAppError";
    }
  }
  return {
    GithubAppError,
    readGithubAppCredentials: vi.fn(),
    readGithubAppStatus: vi.fn(),
  };
});
vi.mock("@/lib/integrations/github-app", () => app);

const credentials = vi.hoisted(() => ({
  applyGithubSource: vi.fn(),
  readStoredGithubSource: vi.fn(),
}));
vi.mock("@/lib/integrations/github-credentials", () => credentials);

import { reconcileGithubSource } from "@/lib/integrations/github-reconcile";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER = "user-1";
const APP_ROW = {
  appId: "1",
  clientId: "c",
  clientSecret: "s",
  privateKey: "k",
  enabled: true,
  slug: "saale",
};

const AUTHORIZED = {
  configured: true,
  slug: "saale",
  name: "Saale",
  permissions: null,
  authorized: { login: "octocat", expiresAt: null },
  installations: [
    {
      installationId: "1234",
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      repositories: ["saale"],
      suspended: false,
    },
  ],
};

function codes(result: { notices: { code: string }[] }): string[] {
  return result.notices.map((notice) => notice.code);
}

beforeEach(() => {
  redisStore.clear();
  cli.githubCliLogin.mockReset();
  settings.ensureAdminSettings.mockReset();
  settings.setSetting.mockReset();
  app.readGithubAppCredentials.mockReset();
  app.readGithubAppStatus.mockReset();
  credentials.applyGithubSource.mockReset();
  credentials.readStoredGithubSource.mockReset();

  settings.ensureAdminSettings.mockResolvedValue({ githubMethod: "choice" });
  settings.setSetting.mockResolvedValue(undefined);
  credentials.readStoredGithubSource.mockResolvedValue("");
  credentials.applyGithubSource.mockResolvedValue(undefined);
  app.readGithubAppCredentials.mockResolvedValue(null);
  cli.githubCliLogin.mockResolvedValue(null);
});

// ─── The three outcomes ─────────────────────────────────────────────────────

describe("reconcileGithubSource", () => {
  it("adopts a CLI login on an instance without an app", async () => {
    cli.githubCliLogin.mockResolvedValue("octocat");

    const result = await reconcileGithubSource(USER);

    expect(result.target).toBe("cli");
    expect(result.changed).toBe(true);
    expect(codes(result)).toEqual(["adopted-cli"]);
    expect(credentials.applyGithubSource).toHaveBeenCalledWith(USER, "cli");
    expect(settings.setSetting).toHaveBeenCalledWith(USER, "github.source", "cli");
  });

  it("switches a workspace to the app once it is authorized and installed", async () => {
    app.readGithubAppCredentials.mockResolvedValue(APP_ROW);
    app.readGithubAppStatus.mockResolvedValue(AUTHORIZED);

    const result = await reconcileGithubSource(USER);

    expect(result.target).toBe("app");
    expect(result.error).toBeNull();
    expect(credentials.applyGithubSource).toHaveBeenCalledWith(USER, "app");
    expect(settings.setSetting).toHaveBeenCalledWith(USER, "github.source", "app");
  });

  it("removes a CLI login when the instance offers only the app", async () => {
    settings.ensureAdminSettings.mockResolvedValue({ githubMethod: "app" });
    app.readGithubAppCredentials.mockResolvedValue(APP_ROW);
    app.readGithubAppStatus.mockResolvedValue(AUTHORIZED);
    cli.githubCliLogin.mockResolvedValue("octocat");

    const result = await reconcileGithubSource(USER);

    expect(result.target).toBe("app");
    // The removal is what tells the user their gh login is gone.
    expect(codes(result)).toContain("removed-cli");
    expect(credentials.applyGithubSource).toHaveBeenCalledWith(USER, "app");
  });

  it("leaves the stored source alone when the workspace cannot be changed", async () => {
    app.readGithubAppCredentials.mockResolvedValue(APP_ROW);
    app.readGithubAppStatus.mockResolvedValue(AUTHORIZED);
    credentials.applyGithubSource.mockRejectedValue(
      new app.GithubAppError("Connect GitHub again: the app's authorization has expired."),
    );

    const result = await reconcileGithubSource(USER);

    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/authorization has expired/);
    // A state that claims "app" while no token is in the workspace is what this
    // function exists to prevent.
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("does nothing when the stored source already matches", async () => {
    credentials.readStoredGithubSource.mockResolvedValue("cli");
    cli.githubCliLogin.mockResolvedValue("octocat");

    const result = await reconcileGithubSource(USER);

    expect(result.target).toBe("cli");
    expect(result.changed).toBe(false);
    expect(result.notices).toEqual([]);
    expect(settings.setSetting).not.toHaveBeenCalled();
    // The helper is still re-asserted: it is what keeps exactly one in place.
    expect(credentials.applyGithubSource).toHaveBeenCalledWith(USER, "cli");
  });

  it("leaves both alone when nothing is connected", async () => {
    const result = await reconcileGithubSource(USER);

    expect(result.target).toBe("");
    expect(result.changed).toBe(false);
    expect(credentials.applyGithubSource).toHaveBeenCalledWith(USER, "");
  });
});

// ─── Throttle and force ─────────────────────────────────────────────────────

describe("reconcile throttle", () => {
  it("does the probes once a minute", async () => {
    cli.githubCliLogin.mockResolvedValue("octocat");

    await reconcileGithubSource(USER);
    await reconcileGithubSource(USER);

    expect(cli.githubCliLogin).toHaveBeenCalledTimes(1);
  });

  it("does them again when forced", async () => {
    cli.githubCliLogin.mockResolvedValue("octocat");

    await reconcileGithubSource(USER);
    await reconcileGithubSource(USER, { force: true });

    expect(cli.githubCliLogin).toHaveBeenCalledTimes(2);
  });
});
