import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getRoleAccess: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireSession: (...args: unknown[]) => mocks.requireSession(...args),
}));

vi.mock("@/lib/permissions/check", () => ({
  getRoleAccess: (...args: unknown[]) => mocks.getRoleAccess(...args),
}));

import { GET } from "@/app/api/permissions/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  mocks.getRoleAccess.mockResolvedValue({
    role: "support",
    permissions: { admin: ["access", "users"], user: ["list", "get"], session: ["list"] },
  });
});

describe("GET /api/permissions", () => {
  it("rejects a request without a session", async () => {
    mocks.requireSession.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.getRoleAccess).not.toHaveBeenCalled();
  });

  it("returns the caller's merged grants", async () => {
    const body = await (await GET()).json();

    expect(body).toEqual({
      role: "support",
      permissions: { admin: ["access", "users"], user: ["list", "get"], session: ["list"] },
    });
    expect(mocks.getRoleAccess).toHaveBeenCalledWith("user-1");
  });
});
