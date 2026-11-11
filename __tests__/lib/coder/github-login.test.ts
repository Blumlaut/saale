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
    mocks.runInWorkspace.mockResolvedValue({
      stdout: ghAnswer({ login: "Juli04", state: "success" }),
      stderr: "",
      exitCode: 0,
    });

    expect(await githubCliLogin(USER)).toBe("Juli04");
  });

  it("ignores a credential that only exists because of a GH_TOKEN variable", async () => {
    // gh reports the variable it was handed, with the variable as its source.
    mocks.runInWorkspace.mockResolvedValue({
      stdout: ghAnswer({ login: "Juli04", state: "success", tokenSource: "GH_TOKEN" }),
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
