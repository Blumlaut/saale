import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    sharedPrompt: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      findFirst: (...args: unknown[]) => mocks.findFirst(...args),
      create: (...args: unknown[]) => mocks.create(...args),
      update: (...args: unknown[]) => mocks.update(...args),
      deleteMany: (...args: unknown[]) => mocks.deleteMany(...args),
    },
  },
}));

import { GET, POST } from "@/app/api/admin/shared-prompts/route";
import { DELETE, PATCH } from "@/app/api/admin/shared-prompts/[promptId]/route";

const FORBIDDEN = {
  ok: false as const,
  response: Response.json({ error: "Forbidden" }, { status: 403 }),
};

const VALID = {
  name: "Wip",
  description: "Write the work in progress notes",
  argumentHint: "[range]",
  scope: "any",
  content: "Write the work in progress notes for ${1:-today}.",
};

function request(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/admin/shared-prompts", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(promptId: string) {
  return { params: Promise.resolve({ promptId }) };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "shared-1",
    name: "wip",
    description: VALID.description,
    argumentHint: VALID.argumentHint,
    scope: "any",
    content: VALID.content,
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-01T09:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ ok: true, user: { id: "admin-1" } });
  mocks.findMany.mockResolvedValue([]);
  mocks.findFirst.mockResolvedValue(null);
});

describe("shared prompts are the instance's rows", () => {
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

  it("lists every shared prompt, unscoped by account", async () => {
    mocks.findMany.mockResolvedValue([row()]);

    const body = await (await GET()).json();

    expect(mocks.findMany).toHaveBeenCalledWith({ orderBy: { name: "asc" } });
    expect(body.prompts).toEqual([
      {
        id: "shared-1",
        name: "wip",
        description: VALID.description,
        argumentHint: VALID.argumentHint,
        scope: "any",
        content: VALID.content,
        updatedAt: "2026-01-01T09:00:00.000Z",
      },
    ]);
  });

  it("writes a new prompt without an owner column", async () => {
    mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      row({ ...data }),
    );

    const response = await POST(request("POST", VALID));

    expect(response.status).toBe(200);
    const { data } = mocks.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data).toEqual({
      name: "wip",
      description: VALID.description,
      argumentHint: VALID.argumentHint,
      scope: "any",
      content: VALID.content,
    });
    expect(data).not.toHaveProperty("userId");
  });

  it("refuses a name the instance already offers", async () => {
    mocks.findFirst.mockResolvedValue(row());

    const response = await POST(request("POST", VALID));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The instance already has a prompt named /wip.",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("404s on a prompt the instance does not have", async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    expect((await PATCH(request("PATCH", VALID), params("shared-9"))).status).toBe(404);
    expect((await DELETE(request("DELETE", {}), params("shared-9"))).status).toBe(404);
  });
});
