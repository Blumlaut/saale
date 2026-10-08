import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every agent session must run in the user's Open Terminal home.
 *
 * Pi resolves relative tool paths against the session cwd (`ctx.cwd`), so using
 * the JSONL transcript directory as the cwd sent `write`/`edit` to
 * `/app/uploads/...` *inside the container*, where the unprivileged session
 * user cannot create them (Open Terminal error 400). The wrapper centralises
 * both the cwd and the in-memory settings so no call site can regress it.
 */

const mocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  settingsInMemory: vi.fn(() => ({ inMemorySettings: true })),
  isConfigured: vi.fn(),
  getTerminalHomeDir: vi.fn((userId: string) => `/home/ot-${userId}`),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mocks.createAgentSession,
  SettingsManager: { inMemory: mocks.settingsInMemory },
}));

vi.mock("@/lib/terminal/client", () => ({
  isConfigured: mocks.isConfigured,
  getTerminalHomeDir: mocks.getTerminalHomeDir,
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
  mocks.createAgentSession.mockResolvedValue({ session: {}, extensionsResult: {} });
});

describe("resolveAgentCwd", () => {
  it("uses the Open Terminal home when the terminal is configured", () => {
    mocks.isConfigured.mockReturnValue(true);

    expect(resolveAgentCwd("user-1", "/app/uploads/pi_sessions/user-1/chat-1")).toBe(
      "/home/ot-user-1",
    );
  });

  it("keeps the fallback when the terminal is not configured", () => {
    mocks.isConfigured.mockReturnValue(false);

    expect(resolveAgentCwd("user-1", "/app/uploads/pi_sessions/user-1/chat-1")).toBe(
      "/app/uploads/pi_sessions/user-1/chat-1",
    );
  });
});

describe("createSaaleAgentSession", () => {
  it("runs the session in the terminal home, not the transcript directory", async () => {
    mocks.isConfigured.mockReturnValue(true);

    await createSaaleAgentSession("user-1", {
      sessionManager: sessionManager("/app/uploads/pi_sessions/user-1/chat-1"),
      noTools: "builtin",
    });

    expect(lastOptions().cwd).toBe("/home/ot-user-1");
  });

  it("falls back to the session manager cwd when the terminal is not configured", async () => {
    mocks.isConfigured.mockReturnValue(false);

    await createSaaleAgentSession("user-1", {
      sessionManager: sessionManager("/app/uploads/pi_sessions/user-1/chat-1"),
    });

    expect(lastOptions().cwd).toBe("/app/uploads/pi_sessions/user-1/chat-1");
  });

  it("does not let a caller override the cwd or the settings manager", async () => {
    mocks.isConfigured.mockReturnValue(true);

    // A rogue call site could smuggle these past the type-level Omit.
    await createSaaleAgentSession("user-1", {
      sessionManager: sessionManager("/app/uploads/pi_sessions/user-1/chat-1"),
      cwd: "/app/uploads/pi_sessions/user-1/chat-1",
      settingsManager: "host-settings",
    } as never);

    expect(lastOptions().cwd).toBe("/home/ot-user-1");
    expect(lastOptions().settingsManager).toEqual({ inMemorySettings: true });
  });

  it("passes the in-memory Saale settings to every session", async () => {
    mocks.isConfigured.mockReturnValue(false);

    await createSaaleAgentSession("user-1", {});

    expect(mocks.settingsInMemory).toHaveBeenCalled();
    expect(lastOptions().settingsManager).toEqual({ inMemorySettings: true });
  });
});
