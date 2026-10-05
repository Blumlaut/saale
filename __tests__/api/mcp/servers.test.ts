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

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    mcpServer: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
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
}));

import { GET, POST } from "@/app/api/mcp/servers/route";
import { DELETE, PATCH } from "@/app/api/mcp/servers/[serverId]/route";
import { POST as testServer } from "@/app/api/mcp/servers/[serverId]/test/route";

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

describe("/api/mcp/servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    auth();
    mockEvictUserSessions.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]);
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
    const body = await (await GET()).json();
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: "asc" },
    });
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({ name: "homeassistant", hasToken: false });
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
});

describe("/api/mcp/servers/:serverId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    auth();
    mockEvictUserSessions.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]);
    mockFindFirst.mockResolvedValue(serverRow());
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

  it("clears a stored token when given an empty string", async () => {
    mockUpdate.mockResolvedValue(serverRow());
    await PATCH(request("PATCH", { token: "" }), params("srv-1"));
    const { data } = mockUpdate.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.encryptedToken).toBeNull();
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
});

describe("/api/mcp/servers/:serverId/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetKey();
    auth();
    mockFindFirst.mockResolvedValue(serverRow());
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

  it("reports a failed connection as a 502 with the reason", async () => {
    mockProbeMcpServer.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8123"));

    const response = await testServer(request("POST", {}), params("srv-1"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      success: false,
      error: "connect ECONNREFUSED 127.0.0.1:8123",
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
});
