// Set env before importing the crypto module.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { _resetKey, decrypt, encrypt } from "@/lib/crypto";

const mockRequireSession = vi.fn();
const mockFindMany = vi.fn();
const mockFindFirst = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDeleteMany = vi.fn();
const mockEvictUserSessions = vi.fn();
const mockSharedFindMany = vi.fn();
const mockOAuthFindMany = vi.fn();
const mockOAuthFindFirst = vi.fn();
const mockOAuthDeleteMany = vi.fn();
const mockOAuthUpsert = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    sharedMcpServer: {
      findMany: (...args: unknown[]) => mockSharedFindMany(...args),
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    mcpServer: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
    mcpOAuthCredential: {
      findMany: (...args: unknown[]) => mockOAuthFindMany(...args),
      findFirst: (...args: unknown[]) => mockOAuthFindFirst(...args),
      deleteMany: (...args: unknown[]) => mockOAuthDeleteMany(...args),
      upsert: (...args: unknown[]) => mockOAuthUpsert(...args),
    },
  },
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  evictUserSessions: (...args: unknown[]) => mockEvictUserSessions(...args),
}));

const mockProbeMcpServer = vi.fn();
vi.mock("@/lib/mcp/probe", () => ({
  probeMcpServer: (...args: unknown[]) => mockProbeMcpServer(...args),
  describeProbeError: (err: unknown) => (err as Error).message,
  isMcpOAuthRequired: () => false,
}));

const mockProbeCommand = vi.fn();
vi.mock("@/lib/mcp/stdio", () => ({
  probeStdioMcpServer: (...args: unknown[]) => mockProbeCommand(...args),
}));

const mockCanExec = vi.fn();
vi.mock("@/lib/sandbox/client", () => ({
  canExec: () => mockCanExec(),
}));

import { GET, POST } from "@/app/api/mcp/servers/route";
import { DELETE, PATCH } from "@/app/api/mcp/servers/[serverId]/route";
import { POST as testServer } from "@/app/api/mcp/servers/[serverId]/test/route";
import { POST as POST_IMPORT } from "@/app/api/mcp/servers/import/route";

const USER_ID = "user-1";

function auth() {
  mockRequireSession.mockResolvedValue({ ok: true, user: { id: USER_ID } });
}

function request(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/mcp/servers", {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });
}

function params(serverId: string) {
  return { params: Promise.resolve({ serverId }) };
}

function serverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "srv-1",
    userId: USER_ID,
    name: "homeassistant",
    transport: "http",
    url: "https://homeassistant.local:8123/api/mcp",
    command: null,
    cwd: null,
    description: "Control the smart home",
    encryptedToken: null,
    toolPolicy: "ask",
    enabled: true,
    chatEnabled: true,
    coderEnabled: true,
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-01T09:00:00Z"),
    ...overrides,
  };
}

describe("/api/mcp/servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    auth();
    mockEvictUserSessions.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]);
    mockSharedFindMany.mockResolvedValue([]);
    mockOAuthFindMany.mockResolvedValue([]);
    mockOAuthFindFirst.mockResolvedValue(null);
  });

  it("requires a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await GET()).status).toBe(401);
    expect((await POST(request("POST", { name: "x", url: "https://x/mcp" }))).status).toBe(401);
  });

  it("lists only the caller's servers", async () => {
    mockFindMany.mockResolvedValue([serverRow()]);
    mockOAuthFindMany.mockResolvedValue([{ serverId: "srv-1" }]);
    const body = await (await GET()).json();
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: "asc" },
    });
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({
      name: "homeassistant",
      hasToken: false,
      hasOAuth: true,
    });
  });

  it("lists the instance's servers after the caller's own, without their sign-in", async () => {
    mockFindMany.mockResolvedValue([serverRow()]);
    mockSharedFindMany.mockResolvedValue([
      serverRow({ id: "shared-1", userId: undefined, name: "docs" }),
    ]);

    const body = await (await GET()).json();

    expect(
      body.servers.map((server: { name: string; shared: boolean }) => [server.name, server.shared]),
    ).toEqual([
      ["homeassistant", false],
      ["docs", true],
    ]);
    expect(body.servers[1].hasOAuth).toBe(false);
    // Only the caller's own server can carry a stored sign-in.
    expect(mockOAuthFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, serverId: { in: ["srv-1"] } },
      select: { serverId: true },
    });
  });

  it("creates a server and encrypts its token", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serverRow({ ...data, hasToken: undefined }),
    );

    const response = await POST(
      request("POST", {
        name: "homeassistant",
        url: "https://homeassistant.local:8123/api/mcp",
        description: "Control the smart home",
        token: "ha-secret",
        toolPolicy: "allow",
      }),
    );

    expect(response.status).toBe(201);
    const { data } = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.userId).toBe(USER_ID);
    expect(data.toolPolicy).toBe("allow");
    // The stored value is ciphertext, never the token itself.
    expect(data.encryptedToken).not.toBe("ha-secret");
    expect(decrypt(data.encryptedToken as string)).toBe("ha-secret");
    // A new server changes what the user's pooled chats can call.
    expect(mockEvictUserSessions).toHaveBeenCalledWith(USER_ID);
  });

  it("rejects an invalid name or URL", async () => {
    const badName = await POST(request("POST", { name: "my server", url: "https://x/mcp" }));
    expect(badName.status).toBe(400);

    const badUrl = await POST(request("POST", { name: "ok", url: "ftp://x/mcp" }));
    expect(badUrl.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an unknown approval setting", async () => {
    const response = await POST(
      request("POST", { name: "ok", url: "https://x/mcp", toolPolicy: "auto" }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a name that collides with an existing server", async () => {
    mockFindMany.mockResolvedValue([serverRow({ name: "home-assistant" })]);
    const response = await POST(
      request("POST", { name: "home_assistant", url: "https://other/mcp" }),
    );
    expect(response.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("creates a command server with no endpoint and no token", async () => {
    mockCreate.mockResolvedValue(
      serverRow({
        transport: "stdio",
        url: null,
        command: "npx -y @modelcontextprotocol/server-filesystem .",
      }),
    );

    const response = await POST(
      request("POST", {
        name: "files",
        transport: "stdio",
        command: "npx -y @modelcontextprotocol/server-filesystem .",
        cwd: "docs",
        token: "ignored",
      }),
    );

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        name: "files",
        transport: "stdio",
        url: null,
        command: "npx -y @modelcontextprotocol/server-filesystem .",
        cwd: "docs",
      }),
    });
    const body = await response.json();
    expect(body.server).toMatchObject({ transport: "stdio", command: expect.any(String) });
    expect(body.server).not.toHaveProperty("encryptedToken");
  });

  it("seals a command server's variables and answers with their names", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serverRow({ ...data }),
    );

    const response = await POST(
      request("POST", {
        name: "github",
        transport: "stdio",
        command: "npx -y @modelcontextprotocol/server-github",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
      }),
    );

    expect(response.status).toBe(201);
    const { data } = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const sealed = JSON.parse(data.env as string) as Record<string, string>;
    expect(Object.keys(sealed)).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    // The stored value is ciphertext, never the token itself.
    expect(sealed.GITHUB_PERSONAL_ACCESS_TOKEN).not.toBe("ghp_secret");
    expect(decrypt(sealed.GITHUB_PERSONAL_ACCESS_TOKEN!)).toBe("ghp_secret");

    const body = await response.json();
    expect(body.server.envNames).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    expect(JSON.stringify(body)).not.toContain("ghp_secret");
  });

  it("ignores variables on an endpoint server", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serverRow({ ...data }),
    );

    await POST(
      request("POST", {
        name: "homeassistant",
        url: "https://homeassistant.local:8123/api/mcp",
        env: { TOKEN: "x" },
      }),
    );

    const { data } = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.env).toBeUndefined();
  });

  it("rejects a command server without a command", async () => {
    const response = await POST(request("POST", { name: "files", transport: "stdio" }));
    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a working directory above the workspace", async () => {
    const response = await POST(
      request("POST", {
        name: "files",
        transport: "stdio",
        command: "node server.mjs",
        cwd: "../someone-else",
      }),
    );
    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects an unknown connection type", async () => {
    const response = await POST(
      request("POST", { name: "files", transport: "carrier-pigeon", url: "https://x/mcp" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("/api/mcp/servers/:serverId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    auth();
    mockEvictUserSessions.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(serverRow());
    mockOAuthFindFirst.mockResolvedValue(null);
  });

  it("updates the fields it is given and scopes the write to the owner", async () => {
    mockUpdate.mockResolvedValue(serverRow({ enabled: false }));

    const response = await PATCH(request("PATCH", { enabled: false }), params("srv-1"));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "srv-1", userId: USER_ID },
      data: { enabled: false },
    });
    expect(mockEvictUserSessions).toHaveBeenCalledWith(USER_ID);
  });

  it("writes the scope flags it is given, and only those", async () => {
    mockUpdate.mockResolvedValue(serverRow({ chatEnabled: false }));

    const response = await PATCH(request("PATCH", { chatEnabled: false }), params("srv-1"));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "srv-1", userId: USER_ID },
      data: { chatEnabled: false },
    });
    const body = await response.json();
    expect(body.server.chatEnabled).toBe(false);
    expect(body.server.coderEnabled).toBe(true);
  });

  it("refuses a scope flag that is not a boolean", async () => {
    const response = await PATCH(request("PATCH", { coderEnabled: "yes" }), params("srv-1"));
    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("clears a stored token when given an empty string", async () => {
    mockUpdate.mockResolvedValue(serverRow());
    await PATCH(request("PATCH", { token: "" }), params("srv-1"));
    const { data } = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.encryptedToken).toBeNull();
  });

  it("reports whether an OAuth sign-in is stored", async () => {
    mockUpdate.mockResolvedValue(serverRow());
    mockOAuthFindFirst.mockResolvedValue({ serverId: "srv-1" });

    const body = await (await PATCH(request("PATCH", { enabled: false }), params("srv-1"))).json();

    expect(body.server.hasOAuth).toBe(true);
  });

  it("drops OAuth credentials when the endpoint changes", async () => {
    mockUpdate.mockResolvedValue(serverRow({ url: "https://new.example/mcp" }));
    mockOAuthDeleteMany.mockResolvedValue({ count: 1 });

    const response = await PATCH(
      request("PATCH", { url: "https://new.example/mcp" }),
      params("srv-1"),
    );

    expect(response.status).toBe(200);
    expect(mockOAuthDeleteMany).toHaveBeenCalledWith({
      where: { serverId: "srv-1", userId: USER_ID },
    });
    expect((await response.json()).server.hasOAuth).toBe(false);
  });

  it("rejects a rename that collides with another of the user's servers", async () => {
    mockFindMany.mockResolvedValue([serverRow({ id: "srv-2", name: "docs" })]);
    const response = await PATCH(request("PATCH", { name: "docs" }), params("srv-1"));
    expect(response.status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("deletes only the caller's server", async () => {
    mockDeleteMany.mockResolvedValue({ count: 1 });
    const body = await (await DELETE(request("DELETE"), params("srv-1"))).json();
    expect(body).toEqual({ ok: true });
    expect(mockDeleteMany).toHaveBeenCalledWith({ where: { id: "srv-1", userId: USER_ID } });
    expect(mockEvictUserSessions).toHaveBeenCalledWith(USER_ID);
  });

  it("404s on an update of a server that is not the caller's", async () => {
    mockFindFirst.mockResolvedValue(null);
    expect((await PATCH(request("PATCH", { enabled: false }), params("srv-x"))).status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("404s when the server belongs to someone else", async () => {
    mockDeleteMany.mockResolvedValue({ count: 0 });
    expect((await DELETE(request("DELETE"), params("srv-x"))).status).toBe(404);
    // Nothing was removed, so pooled sessions keep working.
    expect(mockEvictUserSessions).not.toHaveBeenCalled();
  });

  it("switches a server to a command and drops what the endpoint needed", async () => {
    mockFindFirst.mockResolvedValue(serverRow({ encryptedToken: encrypt("ha-token") }));
    mockUpdate.mockResolvedValue(
      serverRow({ transport: "stdio", url: null, encryptedToken: null, command: "node mcp.mjs" }),
    );

    const response = await PATCH(
      request("PATCH", { transport: "stdio", command: "node mcp.mjs", cwd: "" }),
      params("srv-1"),
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "srv-1", userId: USER_ID },
      data: {
        transport: "stdio",
        command: "node mcp.mjs",
        cwd: null,
        url: null,
        encryptedToken: null,
      },
    });
  });

  it("refuses to switch a server to a command without one", async () => {
    const response = await PATCH(request("PATCH", { transport: "stdio" }), params("srv-1"));
    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("switches a command server back to an endpoint", async () => {
    mockFindFirst.mockResolvedValue(
      serverRow({ transport: "stdio", url: null, command: "node mcp.mjs", cwd: "docs" }),
    );
    mockUpdate.mockResolvedValue(serverRow());

    const response = await PATCH(
      request("PATCH", { transport: "http", url: "https://ha.local/mcp" }),
      params("srv-1"),
    );

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "srv-1", userId: USER_ID },
      data: {
        transport: "http",
        url: "https://ha.local/mcp",
        command: null,
        cwd: null,
      },
    });
  });
});

describe("/api/mcp/servers/:serverId/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    auth();
    mockFindFirst.mockResolvedValue(serverRow());
    mockOAuthFindFirst.mockResolvedValue(null);
  });

  it("tests unsaved form values before anything is stored", async () => {
    mockProbeMcpServer.mockResolvedValue({
      serverName: "fake-home-assistant",
      serverVersion: "2.1.0",
      instructions: null,
      tools: [{ name: "HassTurnOn", description: null }],
    });

    const response = await testServer(
      request("POST", { url: "https://homeassistant.local:8123/api/mcp", token: "ha-token" }),
      params("new"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      serverName: "fake-home-assistant",
      tools: [{ name: "HassTurnOn" }],
    });
    expect(mockProbeMcpServer).toHaveBeenCalledWith({
      url: "https://homeassistant.local:8123/api/mcp",
      token: "ha-token",
    });
  });

  it("uses the stored token when the form does not supply one", async () => {
    mockFindFirst.mockResolvedValue(serverRow({ encryptedToken: encrypt("stored-token") }));
    mockProbeMcpServer.mockResolvedValue({
      serverName: "ha",
      serverVersion: "1",
      instructions: null,
      tools: [],
    });

    await testServer(request("POST", {}), params("srv-1"));

    expect(mockProbeMcpServer).toHaveBeenCalledWith({
      url: "https://homeassistant.local:8123/api/mcp",
      token: "stored-token",
    });
  });

  it("does not silently fall back to the stored token when the form sends an empty one", async () => {
    mockFindFirst.mockResolvedValue(serverRow({ encryptedToken: encrypt("stored-token") }));
    mockProbeMcpServer.mockResolvedValue({
      serverName: "ha",
      serverVersion: "1",
      instructions: null,
      tools: [],
    });

    await testServer(request("POST", { token: "" }), params("srv-1"));

    expect(mockProbeMcpServer).toHaveBeenCalledWith({
      url: "https://homeassistant.local:8123/api/mcp",
      token: null,
    });
  });

  it("tests a tokenless server through its OAuth credentials", async () => {
    mockProbeMcpServer.mockResolvedValue({
      serverName: "linear",
      serverVersion: "1",
      instructions: null,
      tools: [],
    });

    await testServer(request("POST", {}), params("srv-1"));

    const args = mockProbeMcpServer.mock.calls[0]![0] as { token: unknown; authProvider?: unknown };
    expect(args.token).toBeNull();
    expect(args.authProvider).toBeDefined();
  });

  it("reports a failed connection as a 502 with the reason", async () => {
    mockProbeMcpServer.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8123"));

    const response = await testServer(request("POST", {}), params("srv-1"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      success: false,
      error: "connect ECONNREFUSED 127.0.0.1:8123",
      needsAuth: false,
    });
  });

  it("404s for a server the caller does not own", async () => {
    mockFindFirst.mockResolvedValue(null);
    const response = await testServer(request("POST", {}), params("someone-elses"));
    expect(response.status).toBe(404);
    expect(mockProbeMcpServer).not.toHaveBeenCalled();
  });

  it("rejects a malformed URL without connecting", async () => {
    const response = await testServer(request("POST", { url: "not a url" }), params("new"));
    expect(response.status).toBe(400);
    expect(mockProbeMcpServer).not.toHaveBeenCalled();
  });

  it("runs a command server's command in the account's workspace", async () => {
    mockCanExec.mockReturnValue(true);
    mockProbeCommand.mockResolvedValue({
      serverName: "filesystem",
      serverVersion: "1.0.0",
      instructions: null,
      tools: [{ name: "read_file", description: "Read a file" }],
    });

    const response = await testServer(
      request("POST", {
        transport: "stdio",
        name: "files",
        command: "npx -y @modelcontextprotocol/server-filesystem .",
        cwd: "docs",
        env: {},
      }),
      params("new"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      serverName: "filesystem",
      tools: [{ name: "read_file" }],
    });
    expect(mockProbeCommand).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        name: "files",
        command: "npx -y @modelcontextprotocol/server-filesystem .",
        cwd: "docs",
        env: {},
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mockProbeMcpServer).not.toHaveBeenCalled();
  });

  it("reports a failed command with the reason it gave", async () => {
    mockCanExec.mockReturnValue(true);
    mockProbeCommand.mockRejectedValue(new Error('The command for "files" exited\nboom'));

    const response = await testServer(
      request("POST", { transport: "stdio", command: "node missing.mjs" }),
      params("new"),
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining("boom"),
    });
  });

  it("rejects an empty command without running anything", async () => {
    const response = await testServer(
      request("POST", { transport: "stdio", command: "  " }),
      params("new"),
    );
    expect(response.status).toBe(400);
    expect(mockProbeCommand).not.toHaveBeenCalled();
  });

  it("says so when the deployment has no workspace to run a command in", async () => {
    mockCanExec.mockReturnValue(false);

    const response = await testServer(
      request("POST", { transport: "stdio", command: "node mcp.mjs" }),
      params("new"),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining("no workspace service"),
    });
    expect(mockProbeCommand).not.toHaveBeenCalled();
  });

  it("tests the stored command of a saved command server", async () => {
    mockCanExec.mockReturnValue(true);
    mockFindFirst.mockResolvedValue(
      serverRow({ transport: "stdio", url: null, command: "node saved.mjs", cwd: "docs" }),
    );
    mockProbeCommand.mockResolvedValue({
      serverName: "saved",
      serverVersion: "1",
      instructions: null,
      tools: [],
    });

    await testServer(request("POST", {}), params("srv-1"));

    expect(mockProbeCommand).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        name: "homeassistant",
        command: "node saved.mjs",
        cwd: "docs",
        env: {},
      },
      expect.anything(),
    );
  });
});

describe("/api/mcp/servers/import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    auth();
    mockEvictUserSessions.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]);
  });

  it("adds every server of a pasted config", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serverRow({ ...data }),
    );

    const response = await POST_IMPORT(
      request("POST", {
        config: JSON.stringify({
          mcpServers: {
            memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
            docs: { url: "https://docs.example/mcp" },
          },
        }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.created.map((server: { name: string }) => server.name)).toEqual(["memory", "docs"]);
    expect(body.skipped).toEqual([]);

    const first = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(first.data.transport).toBe("stdio");
    expect(first.data.command).toBe("npx -y @modelcontextprotocol/server-memory");
  });

  it("seals the variables a pasted config carries", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serverRow({ ...data }),
    );

    await POST_IMPORT(
      request("POST", {
        config: JSON.stringify({
          mcpServers: {
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
            },
          },
        }),
      }),
    );

    const { data } = mockCreate.mock.calls[0]![0] as { data: Record<string, unknown> };
    const sealed = JSON.parse(data.env as string) as Record<string, string>;
    expect(decrypt(sealed.GITHUB_PERSONAL_ACCESS_TOKEN!)).toBe("ghp_secret");
  });

  it("reports an entry it could not use and adds the rest", async () => {
    mockCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      serverRow({ ...data }),
    );

    const response = await POST_IMPORT(
      request("POST", {
        config: JSON.stringify({
          mcpServers: {
            broken: { type: "stdio" },
            memory: { command: "npx -y @modelcontextprotocol/server-memory" },
          },
        }),
      }),
    );

    const body = await response.json();
    expect(body.created.map((server: { name: string }) => server.name)).toEqual(["memory"]);
    expect(body.skipped).toEqual([
      { name: "broken", error: "This entry has neither a command nor a URL." },
    ]);
  });

  it("reports a name that is already configured", async () => {
    mockFindMany.mockResolvedValue([serverRow({ name: "memory" })]);

    const response = await POST_IMPORT(
      request("POST", {
        config: JSON.stringify({ mcpServers: { memory: { command: "npx -y other" } } }),
      }),
    );

    const body = await response.json();
    expect(body.created).toEqual([]);
    expect(body.skipped[0].error).toContain("already configured");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses text that is not a config", async () => {
    const response = await POST_IMPORT(request("POST", { config: "hello" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("JSON") });
  });

  it("requires a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await POST_IMPORT(request("POST", { config: "{}" }))).status).toBe(401);
  });
});
