import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const mockServers = vi.fn();
const mockDevice = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    mcpServer: { findMany: (...args: unknown[]) => mockServers(...args) },
    device: { findFirst: (...args: unknown[]) => mockDevice(...args) },
  },
}));

import { loadUserMcpServers } from "@/lib/mcp/servers";

const USER_ID = "user-1";

describe("a chat's computer among its MCP servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServers.mockResolvedValue([]);
  });

  it("connects nothing extra for a chat with no computer", async () => {
    const { entries, policies } = await loadUserMcpServers(USER_ID, null);

    expect(entries).toEqual([]);
    expect(policies).toEqual({});
    expect(mockDevice).not.toHaveBeenCalled();
  });

  it("adds the chat's own computer, approved per call", async () => {
    mockDevice.mockResolvedValue({
      id: "dev-1",
      name: "Workstation",
      capabilities: ["screen", "terminal"],
    });

    const { entries, policies, device } = await loadUserMcpServers(USER_ID, "dev-1");

    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("workstation");
    expect(policies).toEqual({ workstation: "ask" });
    // The gate needs the machine itself, not just the tool names.
    expect(device).toEqual({ id: "dev-1", name: "workstation" });
    expect(mockDevice).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "dev-1", userId: USER_ID, revokedAt: null } }),
    );
  });

  it("leaves the device out when its name is already a server's", async () => {
    mockServers.mockResolvedValue([
      {
        id: "srv-1",
        userId: USER_ID,
        name: "workstation",
        url: "https://example.com/mcp",
        description: "",
        encryptedToken: null,
        toolPolicy: "ask",
        enabled: true,
        createdAt: new Date("2026-01-01T09:00:00Z"),
        updatedAt: new Date("2026-01-01T09:00:00Z"),
      },
    ]);
    mockDevice.mockResolvedValue({ id: "dev-1", name: "Workstation", capabilities: [] });

    const { entries } = await loadUserMcpServers(USER_ID, "dev-1");

    expect(entries).toHaveLength(1);
    expect(entries[0]!.config).toMatchObject({ url: "https://example.com/mcp" });
  });
});
