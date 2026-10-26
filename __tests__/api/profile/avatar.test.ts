import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import sharp from "sharp";

const mockRequireSession = vi.fn();
const mockAvatarUpsert = vi.fn();
const mockUserUpdate = vi.fn();
const mockAvatarDeleteMany = vi.fn();
const mockAvatarFindUnique = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mockRequireSession(...args),
}));

// The writes go through one interactive transaction, so the fake client hands
// the same row operations to whatever the callback runs.
vi.mock("@/lib/db", () => {
  const tx = {
    userAvatar: {
      upsert: (...args: unknown[]) => mockAvatarUpsert(...args),
    },
    user: {
      update: (...args: unknown[]) => mockUserUpdate(...args),
    },
  };

  return {
    prisma: {
      // Both shapes the module uses: one callback, and a list of writes.
      $transaction: (input: ((client: typeof tx) => Promise<unknown>) | Promise<unknown>[]) =>
        typeof input === "function" ? input(tx) : Promise.all(input),
      userAvatar: {
        deleteMany: (...args: unknown[]) => mockAvatarDeleteMany(...args),
        findUnique: (...args: unknown[]) => mockAvatarFindUnique(...args),
      },
      user: {
        update: (...args: unknown[]) => mockUserUpdate(...args),
      },
    },
  };
});

import { POST, DELETE } from "@/app/api/profile/avatar/route";
import { GET } from "@/app/api/profile/avatar/[userId]/route";

/** A real 300×300 PNG, as the browser would send it. */
async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 240, g: 90, b: 30 } },
  })
    .png()
    .toBuffer();
}

function uploadRequest(file?: File): NextRequest {
  const form = new FormData();
  if (file) form.append("file", file);
  return new NextRequest("http://localhost/api/profile/avatar", { method: "POST", body: form });
}

describe("POST /api/profile/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
    mockUserUpdate.mockResolvedValue({ id: "user-1", updatedAt: new Date(1_700_000_000_000) });
  });

  it("stores a square picture and answers with its URL", async () => {
    mockAvatarUpsert.mockResolvedValue({ updatedAt: new Date(1_700_000_000_000) });

    const buffer = await png();
    const response = await POST(
      uploadRequest(new File([new Uint8Array(buffer)], "photo.png", { type: "image/png" })),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { image: string };
    expect(body.image).toBe("/api/profile/avatar/user-1?v=1700000000000");

    const written = mockAvatarUpsert.mock.calls[0]![0] as {
      where: { userId: string };
      create: { data: Uint8Array; mimeType: string; width: number; height: number; size: number };
    };
    expect(written.where).toEqual({ userId: "user-1" });
    expect(written.create.mimeType).toBe("image/webp");
    expect(written.create.width).toBe(96);
    expect(written.create.height).toBe(96);
    expect(written.create.size).toBe(written.create.data.byteLength);

    // The row and the URL are written together.
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { image: "/api/profile/avatar/user-1?v=1700000000000" },
    });
  });

  it("refuses a body without a file", async () => {
    const response = await POST(uploadRequest());

    expect(response.status).toBe(400);
    expect(mockAvatarUpsert).not.toHaveBeenCalled();
  });

  it("refuses a file that is not an image", async () => {
    const response = await POST(
      uploadRequest(new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" })),
    );

    expect(response.status).toBe(400);
    expect(mockAvatarUpsert).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    mockRequireSession.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });

    const response = await POST(uploadRequest());

    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/profile/avatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  });

  it("drops the row and the URL", async () => {
    const response = await DELETE();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ image: null });
    expect(mockAvatarDeleteMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { image: null },
    });
  });
});

describe("GET /api/profile/avatar/[userId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  });

  it("serves the stored bytes as an image", async () => {
    mockAvatarFindUnique.mockResolvedValue({
      data: new Uint8Array([82, 73, 70, 70]),
      mimeType: "image/webp",
    });

    const response = await GET(new Request("http://localhost/api/profile/avatar/user-2"), {
      params: Promise.resolve({ userId: "user-2" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
  });

  it("answers 404 for an account without a picture", async () => {
    mockAvatarFindUnique.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/profile/avatar/user-2"), {
      params: Promise.resolve({ userId: "user-2" }),
    });

    expect(response.status).toBe(404);
  });
});
