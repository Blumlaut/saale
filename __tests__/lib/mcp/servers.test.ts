// Set env before importing the crypto module.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { _resetKey, encrypt } from "@/lib/crypto";

const mockFindMany = vi.fn();
const mockSharedFindMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    mcpServer: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
    },
    sharedMcpServer: {
      findMany: (...args: unknown[]) => mockSharedFindMany(...args),
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
    mockSharedFindMany.mockResolvedValue([]);
  });

  it("only reads the user's enabled servers, in the scope the session runs in", async () => {
    mockFindMany.mockResolvedValue([row()]);

    await loadUserMcpServers(USER_ID, { scope: "chat" });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, enabled: true, chatEnabled: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("reads only the coder servers for a coder chat", async () => {
    mockFindMany.mockResolvedValue([row()]);

    await loadUserMcpServers(USER_ID, { scope: "coder" });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, enabled: true, coderEnabled: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("builds a codemode-exposed HTTP entry with the bearer token", async () => {
    mockFindMany.mockResolvedValue([row({ encryptedToken: encrypt("ha-token-123") })]);

    const { entries, policies } = await loadUserMcpServers(USER_ID, { scope: "chat" });

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
    const { entries } = await loadUserMcpServers(USER_ID, { scope: "chat" });
    expect(entries[0]?.config).not.toHaveProperty("headers");
  });

  it("keys the policy by the name Pi derives the tool names from", async () => {
    mockFindMany.mockResolvedValue([
      row({ name: "home-assistant", toolPolicy: "allow" }),
      row({ id: "srv-2", name: "docs", toolPolicy: "nonsense" }),
    ]);

    const { policies } = await loadUserMcpServers(USER_ID, { scope: "chat" });

    expect(policies["home_assistant"]).toBe("allow");
    // An unrecognized stored value must not silently allow a server.
    expect(policies["docs"]).toBe("ask");
  });

  it("connects the instance's servers alongside the user's own", async () => {
    mockFindMany.mockResolvedValue([row()]);
    mockSharedFindMany.mockResolvedValue([
      row({ id: "shared-1", userId: undefined, name: "docs", toolPolicy: "allow" }),
    ]);

    const { entries, policies, oauthServers } = await loadUserMcpServers(USER_ID, {
      scope: "chat",
    });

    expect(mockSharedFindMany).toHaveBeenCalledWith({
      where: { enabled: true, chatEnabled: true },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((entry) => entry.name)).toEqual(["homeassistant", "docs"]);
    expect(policies["docs"]).toBe("allow");
    // OAuth is stored per account, so a shared server has no credential to map.
    expect([...oauthServers.keys()]).toEqual(["homeassistant"]);
  });

  it("keeps the user's server when a shared one folds to the same name", async () => {
    mockFindMany.mockResolvedValue([row({ name: "home-assistant", toolPolicy: "off" })]);
    mockSharedFindMany.mockResolvedValue([
      row({ id: "shared-1", userId: undefined, name: "home_assistant", toolPolicy: "allow" }),
    ]);

    const { entries, policies } = await loadUserMcpServers(USER_ID, { scope: "chat" });

    expect(entries.map((entry) => entry.name)).toEqual(["home-assistant"]);
    expect(policies).toEqual({ home_assistant: "off" });
  });

  it("skips the Authorization header when the stored token cannot be decrypted", async () => {
    mockFindMany.mockResolvedValue([row({ encryptedToken: "not:valid:ciphertext" })]);
    const { entries } = await loadUserMcpServers(USER_ID, { scope: "chat" });
    expect(entries[0]?.config).not.toHaveProperty("headers");
  });

  it("maps servers for OAuth by the key Pi derives tool names from", async () => {
    mockFindMany.mockResolvedValue([row({ name: "home-assistant" })]);

    const { oauthServers } = await loadUserMcpServers(USER_ID, { scope: "chat" });

    expect(oauthServers.get("home_assistant")).toEqual({
      id: "srv-1",
      userId: USER_ID,
      name: "home-assistant",
      url: "https://homeassistant.local:8123/api/mcp",
    });
  });

  it("connects nothing while the mcp category is off", async () => {
    mockFindMany.mockResolvedValue([row()]);

    const { entries, policies, oauthServers } = await loadUserMcpServers(USER_ID, {
      scope: "chat",
      toolConfig: { mcp: false },
    });

    expect(entries).toEqual([]);
    expect(policies).toEqual({});
    expect(oauthServers.size).toBe(0);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("connects the servers for a config that predates the category", async () => {
    mockFindMany.mockResolvedValue([row()]);

    const { entries } = await loadUserMcpServers(USER_ID, {
      scope: "chat",
      toolConfig: { email: true },
    });

    expect(entries).toHaveLength(1);
  });

  it("uses the exposure the user chose for the mcp category", async () => {
    mockFindMany.mockResolvedValue([row()]);

    const { entries } = await loadUserMcpServers(USER_ID, {
      scope: "chat",
      exposure: { mcp: "deferred" },
    });

    expect(entries[0]?.config).toMatchObject({ exposure: "deferred" });
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
    expect(config.exposure).toBe("codemode");
  });

  it("takes the exposure it is given", () => {
    const config = toMcpServerConfig(
      { name: "ha", url: "https://ha/api/mcp", description: "", encryptedToken: null },
      "direct",
    );
    expect(config.exposure).toBe("direct");
  });
});

describe("createUserMcpExtension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    process.env.UPLOADS_DIR = "/tmp/saale-mcp-test";
    mockSharedFindMany.mockResolvedValue([]);
  });

  it("returns null when the user has no enabled servers", async () => {
    mockFindMany.mockResolvedValue([]);
    expect(await createUserMcpExtension(USER_ID, { scope: "chat" })).toBeNull();
  });

  it("returns null while the mcp category is off", async () => {
    mockFindMany.mockResolvedValue([row()]);
    expect(
      await createUserMcpExtension(USER_ID, { scope: "chat", toolConfig: { mcp: false } }),
    ).toBeNull();
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns the extension and the server policies", async () => {
    mockFindMany.mockResolvedValue([row({ toolPolicy: "off" })]);

    const result = await createUserMcpExtension(USER_ID, { scope: "chat" });

    expect(result).not.toBeNull();
    expect(typeof result?.extension).toBe("function");
    expect(result?.policies).toEqual({ homeassistant: "off" });
  });
});
