import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which login counts as the workspace's own.
 *
 * `probeGithub` runs `gh auth status` with the account's `GH_TOKEN` in the
 * environment, so gh reports two very different things the same way: a token it
 * stored itself, and a variable Saale handed it. The source decision may only
 * act on the first — treating a variable as a login is what would let a
 * reconcile drop a working app on behalf of a setting that exists to arbitrate
 * exactly that conflict.
 */

const mocks = vi.hoisted(() => ({
  runInWorkspace: vi.fn(),
  ensureWorkspace: vi.fn(async () => ({})),
  resolveSandboxEnvVar: vi.fn(async () => null),
}));

vi.mock("@/lib/sandbox/workspace", () => ({ ensureWorkspace: mocks.ensureWorkspace }));
vi.mock("@/lib/sandbox/env", () => ({ resolveSandboxEnvVar: mocks.resolveSandboxEnvVar }));
vi.mock("@/lib/sandbox/client", () => ({ exec: vi.fn(), kill: vi.fn() }));
vi.mock("@/lib/coder/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/coder/git")>()),
  runInWorkspace: mocks.runInWorkspace,
}));

const { githubCliLogin } = await import("@/lib/coder/github");

const USER = "user-1";

/** What `gh auth status --json hosts` prints for one host and one credential. */
function ghAnswer(entry: Record<string, unknown>): string {
  return JSON.stringify({
    hosts: { "github.com": [{ host: "github.com", active: true, ...entry }] },
  });
}

describe("githubCliLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds the login gh stored itself", async () => {
    // gh reports the path of the file it stored, not the word "gh".
    mocks.runInWorkspace.mockResolvedValue({
      stdout: ghAnswer({
        login: "Juli04",
        state: "success",
        tokenSource: "/w/.config/gh/hosts.yml",
      }),
      stderr: "",
      exitCode: 0,
    });

    expect(await githubCliLogin(USER)).toBe("Juli04");
  });

  it("prefers the stored login when a variable sits beside it", async () => {
    // With GH_TOKEN set, gh lists that token as the active entry and the stored
    // login as an inactive one; only the second is a login of the workspace.
    mocks.runInWorkspace.mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          "github.com": [
            {
              host: "github.com",
              active: true,
              state: "success",
              login: "Juli04",
              tokenSource: "GH_TOKEN",
            },
            {
              host: "github.com",
              active: false,
              state: "success",
              login: "Juli04",
              tokenSource: "/w/.config/gh/hosts.yml",
            },
          ],
        },
      }),
      stderr: "",
      exitCode: 0,
    });

    expect(await githubCliLogin(USER)).toBe("Juli04");
  });

  it("raises nothing on a credential gh was handed through a variable", async () => {
    mocks.runInWorkspace.mockResolvedValue({
      stdout: JSON.stringify({
        hosts: {
          "github.com": [
            {
              host: "github.com",
              active: true,
              state: "success",
              login: "Juli04",
              tokenSource: "GH_TOKEN",
            },
          ],
        },
      }),
      stderr: "",
      exitCode: 0,
    });

    expect(await githubCliLogin(USER)).toBeNull();
  });

  it("says nothing when gh has no credential at all", async () => {
    mocks.runInWorkspace.mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 1 });

    expect(await githubCliLogin(USER)).toBeNull();
  });
});
