import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveGithubUserEnv } from "@/lib/integrations/github-credentials";

/**
 * The token a call that is *attributed* uses.
 *
 * A pull request opened with an installation token is authored by the app's bot.
 * The person's own authorization is what GitHub records as the author, so this
 * has to hand out that token — and nothing at all when the workspace is not on
 * the app, or the authorization is gone.
 */

const mocks = vi.hoisted(() => ({
  ensureUserSettings: vi.fn(),
  ensureAdminSettings: vi.fn(),
  readGithubUserAccess: vi.fn(),
}));

vi.mock("@/lib/settings/update", () => ({
  ensureUserSettings: mocks.ensureUserSettings,
  ensureAdminSettings: mocks.ensureAdminSettings,
}));
vi.mock("@/lib/integrations/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/github-app")>()),
  readGithubUserAccess: mocks.readGithubUserAccess,
}));

const USER = "user-1";

beforeEach(() => {
  mocks.ensureAdminSettings.mockResolvedValue({ githubTokenPrecedence: "app" });
});

/** Run the function with the stored source set the way the account left it. */
async function withSource(source: string, run: () => Promise<unknown>) {
  mocks.ensureUserSettings.mockResolvedValue({ githubSource: source });
  return run();
}

describe("resolveGithubUserEnv", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureAdminSettings.mockResolvedValue({ githubTokenPrecedence: "app" });
  });

  it("hands out the connected account's own token", async () => {
    mocks.readGithubUserAccess.mockResolvedValue({ accessToken: "gho_personal", login: "Juli04" });

    const env = await withSource("app", () => resolveGithubUserEnv(USER));

    expect(env).toEqual({ GH_TOKEN: "gho_personal" });
    expect(mocks.readGithubUserAccess).toHaveBeenCalledWith(USER);
  });

  it("gives nothing when the workspace is not on the app", async () => {
    expect(await withSource("cli", () => resolveGithubUserEnv(USER))).toEqual({});
    expect(mocks.readGithubUserAccess).not.toHaveBeenCalled();
  });

  it("gives nothing when the account never chose a source", async () => {
    expect(await withSource("", () => resolveGithubUserEnv(USER))).toEqual({});
  });

  it("gives nothing when the authorization is gone", async () => {
    mocks.readGithubUserAccess.mockResolvedValue(null);

    expect(await withSource("app", () => resolveGithubUserEnv(USER))).toEqual({});
  });

  it("gives nothing, and says so, when the token read throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.readGithubUserAccess.mockRejectedValue(new Error("database is down"));

    expect(await withSource("app", () => resolveGithubUserEnv(USER))).toEqual({});
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("GitHub authorization"),
      expect.any(Error),
    );
    logged.mockRestore();
  });
});

/**
 * `admin.githubTokenPrecedence` decides which credential a workspace uses, and
 * it has to hold for the call that opens a pull request too: with "variable" the
 * account's own token is the one that wins, and this may not quietly replace it.
 * Without one there is nothing to win with, so the app still answers.
 */
describe("resolveGithubUserEnv and the token precedence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ensureUserSettings.mockResolvedValue({ githubSource: "app" });
    mocks.readGithubUserAccess.mockResolvedValue({ accessToken: "gho_personal", login: "Juli04" });
  });

  it("leaves the account's own variable alone when the instance prefers it", async () => {
    mocks.ensureAdminSettings.mockResolvedValue({ githubTokenPrecedence: "variable" });

    expect(await resolveGithubUserEnv(USER, { GH_TOKEN: "ghp_own" })).toEqual({});
  });

  it("still answers when the account keeps no variable of its own", async () => {
    mocks.ensureAdminSettings.mockResolvedValue({ githubTokenPrecedence: "variable" });

    expect(await resolveGithubUserEnv(USER, {})).toEqual({ GH_TOKEN: "gho_personal" });
  });

  it("replaces the variable when the instance prefers the app", async () => {
    mocks.ensureAdminSettings.mockResolvedValue({ githubTokenPrecedence: "app" });

    expect(await resolveGithubUserEnv(USER, { GH_TOKEN: "ghp_own" })).toEqual({
      GH_TOKEN: "gho_personal",
    });
  });
});
