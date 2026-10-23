import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every agent session must run in the user's workspace directory.
 *
 * Pi resolves relative tool paths against the session cwd (`ctx.cwd`), so using
 * the JSONL transcript directory as the cwd sent `write`/`edit` to
 * `/app/uploads/...`, a path the workspace does not have. The wrapper
 * centralises both the cwd and the in-memory settings so no call site can
 * regress it.
 */

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  settingsInMemory: vi.fn(() => ({ inMemorySettings: true })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocks.createAgentSession,
  SettingsManager: { inMemory: mocks.settingsInMemory },
}));

import { createSaaleAgentSession, resolveAgentCwd } from "@/lib/pi/agent-session";

/** A session manager whose cwd is the transcript directory. */
function sessionManager(cwd: string) {
  return { getCwd: () => cwd } as never;
}

function lastOptions(): Record<string, unknown> {
  return mocks.createAgentSession.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");
  mocks.createAgentSession.mockResolvedValue({ session: {}, extensionsResult: {} });
});

describe("resolveAgentCwd", () => {
  it("uses the user's workspace directory", () => {
    expect(resolveAgentCwd("user-1")).toBe("/workspaces/user-user-1");
  });

  it("follows a deployment that mounts the volume somewhere else", () => {
    vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/srv/workspaces");

    expect(resolveAgentCwd("user-1")).toBe("/srv/workspaces/user-user-1");
  });

  it("resolves a workspace-relative directory inside the workspace", () => {
    expect(resolveAgentCwd("user-1", "worktrees/x/y")).toBe(
      "/workspaces/user-user-1/worktrees/x/y",
    );
  });

  it("normalises a relative path that stays inside the workspace", () => {
    expect(resolveAgentCwd("user-1", "worktrees/./saale/../saale/c-chat1")).toBe(
      "/workspaces/user-user-1/worktrees/saale/c-chat1",
    );
  });

  it("refuses a relative path that climbs out of the workspace", () => {
    expect(() => resolveAgentCwd("user-1", "../other")).toThrow(/outside the workspace/);
    expect(() => resolveAgentCwd("user-1", "worktrees/../../other")).toThrow(
      /outside the workspace/,
    );
  });

  it("refuses an absolute path, inside the workspace or not", () => {
    // Absolute paths are the host's view; a caller only ever names a directory.
    expect(() => resolveAgentCwd("user-1", "/etc")).toThrow(/outside the workspace/);
    expect(() => resolveAgentCwd("user-1", "/app/uploads/pi_sessions/user-1/chat-1")).toThrow(
      /outside the workspace/,
    );
  });
});

describe("createSaaleAgentSession", () => {
  it("runs the session in the workspace, not the transcript directory", async () => {
    await createSaaleAgentSession("user-1", {
      sessionManager: sessionManager("/app/uploads/pi_sessions/user-1/chat-1"),
      noTools: "builtin",
    });

    expect(lastOptions().cwd).toBe("/workspaces/user-user-1");
  });

  it("does not let a caller override the cwd or the settings manager", async () => {
    // A rogue call site could smuggle these past the type-level Omit.
    await createSaaleAgentSession("user-1", {
      sessionManager: sessionManager("/app/uploads/pi_sessions/user-1/chat-1"),
      cwd: "/app/uploads/pi_sessions/user-1/chat-1",
      settingsManager: "host-settings",
    } as never);

    expect(lastOptions().cwd).toBe("/workspaces/user-user-1");
    expect(lastOptions().settingsManager).toEqual({ inMemorySettings: true });
  });

  it("passes the in-memory Saale settings to every session", async () => {
    await createSaaleAgentSession("user-1", {});

    expect(mocks.settingsInMemory).toHaveBeenCalled();
    expect(lastOptions().settingsManager).toEqual({ inMemorySettings: true });
  });

  it("runs a coder session in its worktree", async () => {
    await createSaaleAgentSession("user-1", {
      sessionManager: sessionManager("/app/uploads/pi_sessions/user-1/chat-1"),
      workspaceCwd: "worktrees/saale/c-chat1",
    });

    expect(lastOptions().cwd).toBe("/workspaces/user-user-1/worktrees/saale/c-chat1");
  });

  it("refuses a workspace cwd that leaves the workspace", async () => {
    await expect(
      createSaaleAgentSession("user-1", { workspaceCwd: "../other-user" }),
    ).rejects.toThrow(/outside the workspace/);
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });
});
