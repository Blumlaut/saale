import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requireSession: vi.fn(),
  db: {
    prompt: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ requireSession: hoisted.requireSession }));
vi.mock("@/lib/db", () => ({ prisma: hoisted.db }));

import { GET, POST } from "@/app/api/prompts/route";
import { DELETE, PATCH } from "@/app/api/prompts/[id]/route";

const USER = "user-1";

const BODY = {
  name: "review",
  description: "Review the staged changes",
  argumentHint: "[focus]",
  scope: "coder",
  content: "Review the staged changes.",
};

function row(overrides = {}) {
  return {
    id: "prompt-1",
    userId: USER,
    ...BODY,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/prompts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function patch(id: string, body: unknown) {
  return PATCH(
    new NextRequest(`http://localhost/api/prompts/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function remove(id: string) {
  return DELETE(new NextRequest(`http://localhost/api/prompts/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.requireSession.mockResolvedValue({ ok: true, user: { id: USER } });
  hoisted.db.prompt.findMany.mockResolvedValue([row()]);
  hoisted.db.prompt.findFirst.mockResolvedValue(null);
  hoisted.db.prompt.create.mockResolvedValue(row());
});

describe("GET /api/prompts", () => {
  it("lists the signed-in user's prompts", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ prompts: [{ id: "prompt-1" }] });
    expect(hoisted.db.prompt.findMany).toHaveBeenCalledWith({
      where: { userId: USER },
      orderBy: { name: "asc" },
    });
  });

  it("refuses an unauthenticated request", async () => {
    hoisted.requireSession.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });

    expect((await GET()).status).toBe(401);
    expect(hoisted.db.prompt.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/prompts", () => {
  it("creates the prompt under the signed-in user", async () => {
    const res = await post(BODY);

    expect(res.status).toBe(200);
    expect(hoisted.db.prompt.create).toHaveBeenCalledWith({ data: { userId: USER, ...BODY } });
    await expect(res.json()).resolves.toMatchObject({ prompt: { name: "review" } });
  });

  it("refuses a name a built-in command owns", async () => {
    const res = await post({ ...BODY, name: "compact" });

    expect(res.status).toBe(400);
    expect(hoisted.db.prompt.create).not.toHaveBeenCalled();
  });

  it("reports a name the user already uses as a conflict", async () => {
    hoisted.db.prompt.findFirst.mockResolvedValue(row());

    const res = await post(BODY);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "You already have a prompt named /review.",
    });
  });
});

describe("PATCH /api/prompts/[id]", () => {
  it("updates the user's own prompt", async () => {
    hoisted.db.prompt.findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    hoisted.db.prompt.update.mockResolvedValue(row({ name: "review" }));

    const res = await patch("prompt-1", { ...BODY, name: "review" });

    expect(res.status).toBe(200);
    expect(hoisted.db.prompt.update).toHaveBeenCalledWith({
      where: { id: "prompt-1", userId: USER },
      data: { ...BODY, name: "review" },
    });
  });

  it("answers 404 for a prompt the user does not own", async () => {
    const res = await patch("prompt-2", BODY);

    expect(res.status).toBe(404);
    expect(hoisted.db.prompt.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/prompts/[id]", () => {
  it("deletes the user's own prompt", async () => {
    hoisted.db.prompt.deleteMany.mockResolvedValue({ count: 1 });

    const res = await remove("prompt-1");

    expect(res.status).toBe(200);
    expect(hoisted.db.prompt.deleteMany).toHaveBeenCalledWith({
      where: { id: "prompt-1", userId: USER },
    });
  });

  it("answers 404 when nothing matched", async () => {
    hoisted.db.prompt.deleteMany.mockResolvedValue({ count: 0 });

    expect((await remove("prompt-9")).status).toBe(404);
  });
});
