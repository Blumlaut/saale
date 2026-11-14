import { beforeEach, describe, expect, it, vi } from "vitest";

const coder = vi.hoisted(() => ({ loadCoderSession: vi.fn() }));
vi.mock("@/lib/coder/changes", () => coder);

const credentials = vi.hoisted(() => ({ readStoredGithubSource: vi.fn() }));
vi.mock("@/lib/integrations/github-credentials", () => credentials);

const app = vi.hoisted(() => ({
  githubInstallationForOwner: vi.fn(),
  mintGithubInstallationToken: vi.fn(),
}));
vi.mock("@/lib/integrations/github-app", () => app);

import { repositoryFromRemote, resolveGithubSessionEnv } from "@/lib/integrations/github-session";

/** The warning that explains a push GitHub will refuse. */
const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const USER = "user-1";
const SESSION = "session-1";

function installation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    rowId: "row-1",
    installationId: "1234",
    accountLogin: "Acme",
    accountType: "Organization",
    repositorySelection: "selected",
    repositories: ["saale"],
    suspended: false,
    ...overrides,
  };
}

function coderSession(originUrl: string | null) {
  return {
    id: SESSION,
    projectId: "project-1",
    project: {
      id: "project-1",
      name: "Saale",
      slug: "saale",
      repoPath: "projects/saale",
      chatMode: "worktree",
      originUrl,
    },
    coderWorktree: {
      path: "worktrees/saale/chat",
      branch: "wt/x",
      baseSha: "abc",
      status: "ready",
    },
  };
}

beforeEach(() => {
  for (const fn of [
    coder.loadCoderSession,
    app.githubInstallationForOwner,
    credentials.readStoredGithubSource,
    app.mintGithubInstallationToken,
  ]) {
    fn.mockReset();
  }
  credentials.readStoredGithubSource.mockResolvedValue("app");
  coder.loadCoderSession.mockResolvedValue(coderSession("https://github.com/acme/saale.git"));
  app.githubInstallationForOwner.mockResolvedValue(installation());
  app.mintGithubInstallationToken.mockResolvedValue({
    token: "ghs_one_repo",
    expiresAt: new Date(Date.now() + 60 * 60_000),
  });
});

// ─── Reading the repository out of a remote ─────────────────────────────────

describe("repositoryFromRemote", () => {
  it("reads the owner and name from every spelling GitHub uses", () => {
    expect(repositoryFromRemote("https://github.com/acme/saale.git")).toEqual({
      owner: "acme",
      repository: "saale",
    });
    expect(repositoryFromRemote("https://github.com/acme/saale")).toEqual({
      owner: "acme",
      repository: "saale",
    });
    expect(repositoryFromRemote("git@github.com:acme/saale.git")).toEqual({
      owner: "acme",
      repository: "saale",
    });
  });

  it("ignores anything that is not a GitHub repository", () => {
    expect(repositoryFromRemote(null)).toBeNull();
    expect(repositoryFromRemote("")).toBeNull();
    expect(repositoryFromRemote("https://gitlab.com/acme/saale.git")).toBeNull();
    expect(repositoryFromRemote("https://github.com/acme")).toBeNull();
    expect(repositoryFromRemote("file:///srv/git/saale.git")).toBeNull();
  });
});

// ─── The token a chat's commands carry ──────────────────────────────────────

describe("resolveGithubSessionEnv", () => {
  it("mints the installation's token, not one for the chat's repository alone", async () => {
    // A change leaves one repository: a branch on a fork, a pull request against
    // the upstream, a second repository read on the way. So the token is the
    // installation's, and GitHub's installation is the ceiling instead of Saale
    // naming a single repository.
    const env = await resolveGithubSessionEnv(USER, SESSION);

    expect(app.mintGithubInstallationToken).toHaveBeenCalledWith({
      userId: USER,
      installationId: "row-1",
      scope: {
        permissions: {
          contents: "write",
          pull_requests: "write",
          workflows: "write",
          checks: "read",
        },
      },
    });
    expect(env).toEqual({ GH_TOKEN: "ghs_one_repo" });
  });

  it("matches the account name case-insensitively", async () => {
    coder.loadCoderSession.mockResolvedValue(coderSession("git@github.com:acme/saale.git"));

    await resolveGithubSessionEnv(USER, SESSION);

    // The lowercase owner reaches the lookup, which matches GitHub's casing rules.
    expect(app.githubInstallationForOwner).toHaveBeenCalledWith(USER, "acme");
  });

  it("carries nothing while the CLI is the source", async () => {
    credentials.readStoredGithubSource.mockResolvedValue("cli");

    expect(await resolveGithubSessionEnv(USER, SESSION)).toEqual({});
    expect(app.mintGithubInstallationToken).not.toHaveBeenCalled();
  });

  it("carries nothing for a chat that is not a coder chat", async () => {
    coder.loadCoderSession.mockResolvedValue(null);

    expect(await resolveGithubSessionEnv(USER, SESSION)).toEqual({});
    expect(app.mintGithubInstallationToken).not.toHaveBeenCalled();
  });

  it("still hands the installation's token for a repository it does not cover", async () => {
    coder.loadCoderSession.mockResolvedValue(coderSession("https://github.com/acme/other.git"));

    const env = await resolveGithubSessionEnv(USER, SESSION);

    // The chat works in `acme/other`, which is not approved: GitHub refuses a
    // push there, while the rest of the installation stays reachable — that is
    // the multi-repository case this token exists for.
    expect(env).toEqual({ GH_TOKEN: "ghs_one_repo" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not cover other"));
  });

  it("carries no credential when the account has no installation for that owner", async () => {
    app.githubInstallationForOwner.mockResolvedValue(null);

    const env = await resolveGithubSessionEnv(USER, SESSION);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env).toEqual(expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }));
    expect(app.mintGithubInstallationToken).not.toHaveBeenCalled();
  });

  it("carries no credential when the mint is refused", async () => {
    app.mintGithubInstallationToken.mockRejectedValue(
      new Error("That GitHub installation is suspended."),
    );

    // A refused mint leaves nothing narrower to use, and the workspace credential
    // would be wider than the chat is allowed, so the command runs without one.
    const env = await resolveGithubSessionEnv(USER, SESSION);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env).toEqual(expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }));
  });
});
