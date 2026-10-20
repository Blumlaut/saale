import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getRoleAccess: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  findUsers: vi.fn(),
  loadRoleDefinitions: vi.fn(),
  refreshRoleDefinitions: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mocks.requirePermission(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    role: {
      findUnique: (...args: unknown[]) => mocks.findUnique(...args),
      create: (...args: unknown[]) => mocks.create(...args),
      update: (...args: unknown[]) => mocks.update(...args),
      delete: (...args: unknown[]) => mocks.delete(...args),
    },
    user: { findMany: (...args: unknown[]) => mocks.findUsers(...args) },
  },
}));

vi.mock("@/lib/permissions/check", () => ({
  getRoleAccess: (...args: unknown[]) => mocks.getRoleAccess(...args),
}));

vi.mock("@/lib/permissions/role-cache", () => ({
  loadRoleDefinitions: (...args: unknown[]) => mocks.loadRoleDefinitions(...args),
  refreshRoleDefinitions: (...args: unknown[]) => mocks.refreshRoleDefinitions(...args),
}));

import { GET, POST } from "@/app/api/admin/roles/route";
import { DELETE, PATCH } from "@/app/api/admin/roles/[roleName]/route";
import { BUILTIN_ROLES } from "@/lib/permissions/roles";

const admin = BUILTIN_ROLES.find((role) => role.name === "admin")!;
const basicUser = BUILTIN_ROLES.find((role) => role.name === "user")!;

/** A caller allowed to manage some accounts, but not to grant more than that. */
const limitedCaller = {
  admin: ["access", "users"],
  user: ["list", "get"],
  session: [],
};

const helpdesk = {
  name: "helpdesk",
  label: "Helpdesk",
  description: "Front desk.",
  permissions: { admin: ["access", "users"], user: ["list"], session: [] },
  builtin: false,
  userCount: 0,
};

function post(body: unknown) {
  return new NextRequest("http://localhost/api/admin/roles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(roleName: string, body: unknown) {
  return new NextRequest(`http://localhost/api/admin/roles/${roleName}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function remove(roleName: string) {
  return new NextRequest(`http://localhost/api/admin/roles/${roleName}`, { method: "DELETE" });
}

const params = (roleName: string) => ({ params: Promise.resolve({ roleName }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ ok: true, user: { id: "admin-1" } });
  mocks.getRoleAccess.mockResolvedValue({ role: "admin", permissions: admin.permissions });
  mocks.loadRoleDefinitions.mockResolvedValue(BUILTIN_ROLES);
  mocks.refreshRoleDefinitions.mockResolvedValue(BUILTIN_ROLES);
  mocks.findUsers.mockResolvedValue([]);
});

describe("GET /api/admin/roles", () => {
  it("requires admin panel access", async () => {
    mocks.requirePermission.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith("admin", "access");
  });

  it("counts the accounts holding each role, including combined roles", async () => {
    const custom = (name: string) => ({
      name,
      label: name,
      description: "",
      permissions: { admin: ["access"], user: [], session: [] },
      builtin: false,
    });
    mocks.loadRoleDefinitions.mockResolvedValue([
      ...BUILTIN_ROLES,
      custom("reviewer"),
      custom("editor"),
    ]);
    mocks.findUsers.mockResolvedValue([
      { role: "reviewer" },
      { role: "reviewer,editor" },
      { role: "user" },
    ]);

    const body = await (await GET()).json();
    const byName = Object.fromEntries(
      (body.roles as Array<{ name: string; userCount: number }>).map((role) => [
        role.name,
        role.userCount,
      ]),
    );

    expect(byName.reviewer).toBe(2);
    expect(byName.editor).toBe(1);
    expect(byName.user).toBe(1);
    expect(byName.admin).toBe(0);
  });
});

describe("POST /api/admin/roles", () => {
  it("requires the roles slice", async () => {
    mocks.requirePermission.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(post({ name: "helpdesk", label: "Helpdesk" }));

    expect(response.status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith("admin", "roles");
  });

  it("rejects a malformed id", async () => {
    const response = await POST(post({ name: "Helpdesk!", label: "Helpdesk" }));

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a name that already exists", async () => {
    mocks.findUnique.mockResolvedValue({ name: "helpdesk" });

    const response = await POST(post({ name: "helpdesk", label: "Helpdesk" }));

    expect(response.status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses to grant a permission the caller does not hold", async () => {
    mocks.getRoleAccess.mockResolvedValue({ role: "helpdesk", permissions: limitedCaller });

    const response = await POST(
      post({
        name: "helpdesk",
        label: "Helpdesk",
        permissions: { admin: ["providers"], user: [], session: [] },
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a role with normalized grants and refreshes the cache", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({
      name: "helpdesk",
      label: "Helpdesk",
      description: "Front desk.",
      permissions: { admin: ["access", "users"], user: ["list"], session: [] },
      builtin: false,
    });

    const response = await POST(
      post({
        name: "helpdesk",
        label: "Helpdesk",
        description: "Front desk.",
        permissions: { admin: ["users", "bogus"], user: ["list"], session: [] },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.role.permissions).toEqual({
      admin: ["access", "users"],
      user: ["list"],
      session: [],
    });
    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "helpdesk", builtin: false }),
    });
    expect(mocks.refreshRoleDefinitions).toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/roles/[roleName]", () => {
  it("refuses to edit an anchor role", async () => {
    const response = await PATCH(patch("admin", { label: "Root" }), params("admin"));

    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown role", async () => {
    mocks.findUnique.mockResolvedValue(null);

    const response = await PATCH(patch("ghost", { label: "Ghost" }), params("ghost"));

    expect(response.status).toBe(404);
  });

  it("refuses grants the caller does not hold", async () => {
    mocks.findUnique.mockResolvedValue({ ...helpdesk });
    mocks.getRoleAccess.mockResolvedValue({ role: "helpdesk", permissions: limitedCaller });

    const response = await PATCH(
      patch("helpdesk", { permissions: { admin: ["models"], user: [], session: [] } }),
      params("helpdesk"),
    );

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("edits the label and grants of an editable role", async () => {
    mocks.findUnique.mockResolvedValue({ ...helpdesk });
    mocks.update.mockResolvedValue({
      ...helpdesk,
      label: "Front desk",
      permissions: { admin: ["access", "users", "settings"], user: ["list"], session: [] },
    });

    const response = await PATCH(
      patch("helpdesk", {
        label: "Front desk",
        permissions: { admin: ["users", "settings"], user: ["list"], session: [] },
      }),
      params("helpdesk"),
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { name: "helpdesk" },
      data: expect.objectContaining({ label: "Front desk" }),
    });
    expect(mocks.refreshRoleDefinitions).toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/roles/[roleName]", () => {
  it("refuses to delete a built-in role", async () => {
    mocks.findUnique.mockResolvedValue({ ...basicUser });

    const response = await DELETE(remove("user"), params("user"));

    expect(response.status).toBe(400);
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("refuses to delete a role that is still assigned", async () => {
    mocks.findUnique.mockResolvedValue({ ...helpdesk });
    mocks.findUsers.mockResolvedValue([{ role: "helpdesk" }, { role: "editor,helpdesk" }]);

    const response = await DELETE(remove("helpdesk"), params("helpdesk"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("2 accounts");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("deletes an unused custom role and refreshes the cache", async () => {
    mocks.findUnique.mockResolvedValue({ ...helpdesk });
    mocks.delete.mockResolvedValue({ ...helpdesk });

    const response = await DELETE(remove("helpdesk"), params("helpdesk"));

    expect(response.status).toBe(200);
    expect(mocks.delete).toHaveBeenCalledWith({ where: { name: "helpdesk" } });
    expect(mocks.refreshRoleDefinitions).toHaveBeenCalled();
  });
});
