// Set env before importing the crypto module.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetKey, encrypt } from "@/lib/crypto";

const mockFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    mcpServer: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
  },
}));

import {
  createUserMcpExtension,
  loadUserMcpServers,
  readMcpToken,
  toMcpServerConfig,
} from "@/lib/mcp/servers";

const USER_ID = "user-1";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-1",
    userId: USER_ID,
    name: "homeassistant",
    url: "https://homeassistant.local:8123/api/mcp",
    description: "Control the smart home",
    encryptedToken: null,
    toolPolicy: "ask",
    enabled: true,
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-01T09:00:00Z"),
    ...overrides,
  };
}

describe("MCP server loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    process.env.UPLOADS_DIR = "/tmp/saale-mcp-test";
  });

  it("only reads servers that belong to the user and are enabled", async () => {
    mockFindMany.mockResolvedValue([row()]);

    await loadUserMcpServers(USER_ID);

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, enabled: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("builds a codemode-exposed HTTP entry with the bearer token", async () => {
    mockFindMany.mockResolvedValue([row({ encryptedToken: encrypt("ha-token-123") })]);

    const { entries, policies } = await loadUserMcpServers(USER_ID);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "homeassistant",
      config: {
        type: "http",
        url: "https://homeassistant.local:8123/api/mcp",
        exposure: "codemode",
        description: "Control the smart home",
        headers: { Authorization: "Bearer ha-token-123" },
      },
    });
    expect(policies).toEqual({ homeassistant: "ask" });
  });

  it("sends no Authorization header when no token is stored", async () => {
    mockFindMany.mockResolvedValue([row({ encryptedToken: null })]);
    const { entries } = await loadUserMcpServers(USER_ID);
    expect(entries[0]?.config).not.toHaveProperty("headers");
  });

  it("keys the policy by the name Pi derives the tool names from", async () => {
    mockFindMany.mockResolvedValue([
      row({ name: "home-assistant", toolPolicy: "allow" }),
      row({ id: "srv-2", name: "docs", toolPolicy: "nonsense" }),
    ]);

    const { policies } = await loadUserMcpServers(USER_ID);

    expect(policies["home_assistant"]).toBe("allow");
    // An unrecognized stored value must not silently allow a server.
    expect(policies["docs"]).toBe("ask");
  });

  it("skips the Authorization header when the stored token cannot be decrypted", async () => {
    mockFindMany.mockResolvedValue([row({ encryptedToken: "not:valid:ciphertext" })]);
    const { entries } = await loadUserMcpServers(USER_ID);
    expect(entries[0]?.config).not.toHaveProperty("headers");
  });

  it("maps servers for OAuth by the key Pi derives tool names from", async () => {
    mockFindMany.mockResolvedValue([row({ name: "home-assistant" })]);

    const { oauthServers } = await loadUserMcpServers(USER_ID);

    expect(oauthServers.get("home_assistant")).toEqual({
      id: "srv-1",
      userId: USER_ID,
      name: "home-assistant",
      url: "https://homeassistant.local:8123/api/mcp",
    });
  });
});

describe("readMcpToken", () => {
  beforeEach(() => {
    _resetKey();
  });

  it("round-trips an encrypted token", () => {
    expect(readMcpToken({ name: "ha", encryptedToken: encrypt("secret") })).toBe("secret");
  });

  it("returns null when no token is stored", () => {
    expect(readMcpToken({ name: "ha", encryptedToken: null })).toBeNull();
  });

  it("logs and returns null for an undecryptable value", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readMcpToken({ name: "ha", encryptedToken: "garbage" })).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("toMcpServerConfig", () => {
  it("omits the description when the server has none", () => {
    const config = toMcpServerConfig({
      name: "ha",
      url: "https://ha/api/mcp",
      description: "",
      encryptedToken: null,
    });
    expect(config).not.toHaveProperty("description");
    // Tools must stay reachable from codemode  never declared to the model.
    expect(config.exposure).toBe("codemode");
  });
});

describe("createUserMcpExtension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    process.env.UPLOADS_DIR = "/tmp/saale-mcp-test";
  });

  it("returns null when the user has no enabled servers", async () => {
    mockFindMany.mockResolvedValue([]);
    expect(await createUserMcpExtension(USER_ID)).toBeNull();
  });

  it("returns the extension and the server policies", async () => {
    mockFindMany.mockResolvedValue([row({ toolPolicy: "off" })]);

    const result = await createUserMcpExtension(USER_ID);

    expect(result).not.toBeNull();
    expect(typeof result?.extension).toBe("function");
    expect(result?.policies).toEqual({ homeassistant: "off" });
  });
});
