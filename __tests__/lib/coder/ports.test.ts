import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ports a chat is allowed to see and stop.
 *
 * Two chats in one project share a container, so the working directory of the
 * process behind a port is the only thing that says whose port it is. These
 * tests are about that boundary, and about a loopback bind getting no link.
 */

const mocks = vi.hoisted(() => ({
  findChat: vi.fn(),
  listPorts: vi.fn(),
  killPort: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { chatSession: { findFirst: mocks.findChat } } }));
vi.mock("@/lib/sandbox/client", () => ({
  isConfigured: () => process.env.SANDBOX_URL !== "",
  listPorts: mocks.listPorts,
  killPort: mocks.killPort,
}));

import {
  killChatPort,
  listChatPorts,
  SandboxUnavailableError,
  UnknownChatPortError,
} from "@/lib/coder/ports";
import { userIdentity } from "@/lib/sandbox/identity";

const USER = "user-1";
const SESSION = "chat-1";
const IDENTITY = userIdentity(USER);
const WORKTREE = `/workspaces/${IDENTITY}/worktrees/saale/c-1a2b3c4d`;

const PORT = (overrides: Record<string, unknown> = {}) => ({
  port: 5173,
  address: "0.0.0.0",
  loopback: false,
  pid: 120,
  command: "node vite",
  cwd: WORKTREE,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");
  vi.stubEnv("BETTER_AUTH_URL", "https://saale.example.com");
  vi.stubEnv("SANDBOX_API_KEY", "0123456789abcdef0123456789abcdef");
  vi.stubEnv("PREVIEW_DOMAIN", "");
  mocks.findChat.mockResolvedValue({
    coderWorktree: { path: "worktrees/saale/c-1a2b3c4d", branch: "wt/c-1", status: "active" },
  });
  mocks.listPorts.mockResolvedValue([PORT()]);
  mocks.killPort.mockResolvedValue({ port: 5173, pid: 120, killed: true });
});

describe("listing a chat's ports", () => {
  it("mints a URL that fits a DNS label for a real user id", async () => {
    // A 32 character id and a five digit port used to overflow the label.
    const userId = "yy7vfya8Gg33Y5ROHdK2WhZRKvGqs5NA";
    const worktree = `/workspaces/${userIdentity(userId)}/worktrees/saale/c-1a2b3c4d`;
    mocks.findChat.mockResolvedValue({
      coderWorktree: { path: "worktrees/saale/c-1a2b3c4d", branch: "wt/c-1", status: "active" },
    });
    mocks.listPorts.mockResolvedValue([PORT({ port: 65535, cwd: worktree })]);
    vi.stubEnv("SANDBOX_WORKSPACES_DIR", "/workspaces");

    const result = await listChatPorts(userId, SESSION);

    const url = result?.ports[0]?.url ?? "";
    expect(url).toMatch(
      /^https:\/\/[0-9a-f]{10}-65535-[0-9a-f]{16}\.preview\.saale\.example\.com$/,
    );
  });

  it("mints a preview URL for a reachable port", async () => {
    const result = await listChatPorts(USER, SESSION);

    expect(mocks.listPorts).toHaveBeenCalledWith(IDENTITY);
    expect(result).toMatchObject({ enabled: true, domain: "preview.saale.example.com" });
    expect(result?.ports).toHaveLength(1);
    expect(result?.ports[0]).toMatchObject({ port: 5173, command: "node vite", loopback: false });
    expect(result?.ports[0]?.url).toMatch(
      /^https:\/\/[0-9a-f]{10}-5173-[0-9a-f]{16}\.preview\.saale\.example\.com$/,
    );
  });

  it("keeps out a server another worktree started", async () => {
    mocks.listPorts.mockResolvedValue([
      PORT({ port: 5173 }),
      PORT({ port: 4000, cwd: `/workspaces/${IDENTITY}/worktrees/saale/c-zzzz`, pid: 200 }),
      PORT({ port: 5000, cwd: `/workspaces/${IDENTITY}/projects/saale`, pid: 300 }),
      // A directory nobody could read is nobody's port.
      PORT({ port: 6000, cwd: null, pid: 400 }),
    ]);

    const result = await listChatPorts(USER, SESSION);

    expect(result?.ports.map((entry) => entry.port)).toEqual([5173]);
  });

  it("includes a server started in a subdirectory of the worktree", async () => {
    mocks.listPorts.mockResolvedValue([PORT({ port: 3000, cwd: `${WORKTREE}/apps/web` })]);

    const result = await listChatPorts(USER, SESSION);

    expect(result?.ports.map((entry) => entry.port)).toEqual([3000]);
  });

  it("lists a loopback port but gives it no link", async () => {
    mocks.listPorts.mockResolvedValue([PORT({ address: "127.0.0.1", loopback: true })]);

    const result = await listChatPorts(USER, SESSION);

    expect(result?.ports[0]).toMatchObject({ port: 5173, loopback: true, url: null });
  });

  it("still lists ports when previews are off", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3630");

    const result = await listChatPorts(USER, SESSION);

    expect(result).toMatchObject({ enabled: false, domain: null });
    expect(result?.ports[0]?.url).toBeNull();
  });

  it("says the sandbox is off rather than reporting no ports", async () => {
    vi.stubEnv("SANDBOX_URL", "");

    await expect(listChatPorts(USER, SESSION)).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(mocks.listPorts).not.toHaveBeenCalled();
  });

  it("answers null for a chat that is not the caller's", async () => {
    mocks.findChat.mockResolvedValue(null);

    await expect(listChatPorts(USER, "chat-other")).resolves.toBeNull();
    expect(mocks.listPorts).not.toHaveBeenCalled();
  });
});

describe("stopping a chat's port", () => {
  it("stops a port the worktree owns", async () => {
    await expect(killChatPort(USER, SESSION, 5173)).resolves.toEqual({
      port: 5173,
      killed: true,
    });
    expect(mocks.killPort).toHaveBeenCalledWith(IDENTITY, 5173);
  });

  it("refuses a port that belongs to another worktree", async () => {
    mocks.listPorts.mockResolvedValue([PORT({ cwd: `/workspaces/${IDENTITY}/worktrees/x/y` })]);

    await expect(killChatPort(USER, SESSION, 5173)).rejects.toBeInstanceOf(UnknownChatPortError);
    expect(mocks.killPort).not.toHaveBeenCalled();
  });

  it("refuses a port that is not listening at all", async () => {
    mocks.listPorts.mockResolvedValue([]);

    await expect(killChatPort(USER, SESSION, 5173)).rejects.toBeInstanceOf(UnknownChatPortError);
    expect(mocks.killPort).not.toHaveBeenCalled();
  });
});
