import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  findUser: vi.fn(),
  findAdminSettings: vi.fn(),
  findUserSettings: vi.fn(),
  setUserFeatures: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...args: unknown[]) => mocks.findUser(...args) },
    adminSettings: { findUnique: (...args: unknown[]) => mocks.findAdminSettings(...args) },
    appSettings: { findUnique: (...args: unknown[]) => mocks.findUserSettings(...args) },
  },
}));

vi.mock("@/lib/settings/update", () => ({
  setUserFeatures: (...args: unknown[]) => mocks.setUserFeatures(...args),
}));

import { GET, PATCH } from "@/app/api/admin/users/[userId]/features/route";
import { FEATURES, type FeatureMap } from "@/lib/permissions/features";

const USER_ID = "user-1";
const params = { params: Promise.resolve({ userId: USER_ID }) };

function request(body: unknown) {
  return new NextRequest(`http://localhost/api/admin/users/${USER_ID}/features`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Every feature on except the council, which ships off. */
function effective(): FeatureMap {
  return Object.fromEntries(FEATURES.map((key) => [key, key !== "council"])) as FeatureMap;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ ok: true, user: { id: "admin-1" } });
  mocks.findUser.mockResolvedValue({ role: "user" });
  mocks.findAdminSettings.mockResolvedValue({ featureDefaults: null });
  mocks.findUserSettings.mockResolvedValue({ features: null });
});

describe("GET /api/admin/users/[userId]/features", () => {
  it("requires the admin users slice", async () => {
    mocks.requirePermission.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await GET(request({}), params);

    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith("admin", "users");
  });

  it("returns the effective set for a regular account", async () => {
    const response = await GET(request({}), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ features: effective(), readOnly: false });
  });

  it("marks an admin account read-only", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    const body = await (await GET(request({}), params)).json();

    expect(body.readOnly).toBe(true);
    expect(Object.values(body.features).every(Boolean)).toBe(true);
  });

  it("404s for an account that does not exist", async () => {
    mocks.findUser.mockResolvedValue(null);

    expect((await GET(request({}), params)).status).toBe(404);
  });
});

describe("PATCH /api/admin/users/[userId]/features", () => {
  it("stores only the switches that differ from the instance defaults", async () => {
    // The instance turns mail off; this account turns it back on and web off.
    mocks.findAdminSettings.mockResolvedValue({ featureDefaults: { mail: false } });
    const wanted = { ...effective(), mail: true, web: false };

    const response = await PATCH(request({ features: wanted }), params);

    expect(response.status).toBe(200);
    expect(mocks.setUserFeatures).toHaveBeenCalledWith(USER_ID, { mail: true, web: false });
  });

  it("refuses an admin account, which always has every feature", async () => {
    mocks.findUser.mockResolvedValue({ role: "admin" });

    const response = await PATCH(request({ features: effective() }), params);

    expect(response.status).toBe(400);
    expect(mocks.setUserFeatures).not.toHaveBeenCalled();
  });

  it("rejects an unknown feature key", async () => {
    const response = await PATCH(request({ features: { nope: true } }), params);

    expect(response.status).toBe(400);
    expect(mocks.setUserFeatures).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean switch", async () => {
    const response = await PATCH(request({ features: { mail: "yes" } }), params);

    expect(response.status).toBe(400);
    expect(mocks.setUserFeatures).not.toHaveBeenCalled();
  });

  it("404s for an account that does not exist", async () => {
    mocks.findUser.mockResolvedValue(null);

    expect((await PATCH(request({ features: effective() }), params)).status).toBe(404);
    expect(mocks.setUserFeatures).not.toHaveBeenCalled();
  });
});
