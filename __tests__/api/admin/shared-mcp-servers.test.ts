// Set env before importing the crypto module.
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { _resetKey, decrypt } from "@/lib/crypto";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
  evictAllSessions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    sharedMcpServer: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      findFirst: (...args: unknown[]) => mocks.findFirst(...args),
      create: (...args: unknown[]) => mocks.create(...args),
      update: (...args: unknown[]) => mocks.update(...args),
      deleteMany: (...args: unknown[]) => mocks.deleteMany(...args),
    },
  },
}));

vi.mock("@/lib/pi/agent-pool", () => ({
  evictAllSessions: (...args: unknown[]) => mocks.evictAllSessions(...args),
  evictUserSessions: vi.fn(),
}));

import { GET, POST } from "@/app/api/admin/shared-mcp-servers/route";
import { DELETE, PATCH } from "@/app/api/admin/shared-mcp-servers/[serverId]/route";

const FORBIDDEN = {
  ok: false as const,
  response: Response.json({ error: "Forbidden" }, { status: 403 }),
};

const VALID = {
  name: "home-assistant",
  url: "https://homeassistant.local:8123/api/mcp",
  description: "Control the smart home",
  token: "house-secret",
  toolPolicy: "allow",
};

function request(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/admin/shared-mcp-servers", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(serverId: string) {
  return { params: Promise.resolve({ serverId }) };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "shared-1",
    name: "home-assistant",
    url: VALID.url,
    description: VALID.description,
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

beforeEach(() => {
  vi.clearAllMocks();
  _resetKey();
  mocks.requirePermission.mockResolvedValue({ ok: true, user: { id: "admin-1" } });
  mocks.findMany.mockResolvedValue([]);
  mocks.findFirst.mockResolvedValue(null);
});

describe("shared MCP servers are the instance's rows", () => {
  it("needs the admin settings slice to read or write them", async () => {
    mocks.requirePermission.mockResolvedValue(FORBIDDEN);

    expect((await GET()).status).toBe(403);
    expect((await POST(request("POST", VALID))).status).toBe(403);
    expect((await PATCH(request("PATCH", VALID), params("shared-1"))).status).toBe(403);
    expect((await DELETE(request("DELETE", {}), params("shared-1"))).status).toBe(403);

    expect(mocks.requirePermission).toHaveBeenCalledWith("admin", "settings");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("stores a server for every account, encrypting its token", async () => {
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data }),
    );

    const response = await POST(request("POST", VALID));

    expect(response.status).toBe(201);
    const { data } = mocks.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty("userId");
    expect(data).toMatchObject({ name: "home-assistant", toolPolicy: "allow" });
    expect(data.encryptedToken).not.toBe("house-secret");
    expect(decrypt(data.encryptedToken as string)).toBe("house-secret");
    // The server was in every pooled chat, so all of them are rebuilt.
    expect(mocks.evictAllSessions).toHaveBeenCalled();
  });

  it("lists the instance's servers, in the order they were added", async () => {
    mocks.findMany.mockResolvedValue([row()]);

    const body = await (await GET()).json();

    expect(mocks.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "asc" } });
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).toMatchObject({ name: "home-assistant", hasToken: false });
  });

  it("refuses a name the instance already offers", async () => {
    mocks.findMany.mockResolvedValue([row({ name: "home_assistant", id: "shared-2" })]);

    const response = await POST(request("POST", VALID));

    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("404s on a server the instance does not have", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    expect((await PATCH(request("PATCH", { enabled: false }), params("shared-9"))).status).toBe(
      404,
    );
    expect((await DELETE(request("DELETE", {}), params("shared-9"))).status).toBe(404);
  });
});
