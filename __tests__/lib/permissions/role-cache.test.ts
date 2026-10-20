import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  createMany: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    role: {
      createMany: (...args: unknown[]) => mocks.createMany(...args),
      findMany: (...args: unknown[]) => mocks.findMany(...args),
    },
  },
}));

import {
  AUTH_ROLES,
  loadRoleDefinitions,
  refreshRoleDefinitions,
  resetRoleCache,
} from "@/lib/permissions/role-cache";
import { BUILTIN_ROLES } from "@/lib/permissions/roles";

const supportRow = {
  name: "support",
  label: "Support",
  description: "Look accounts up.",
  permissions: { admin: ["access", "users"], user: ["list"], session: [] },
  builtin: true,
};

const helpdeskRow = {
  name: "helpdesk",
  label: "Helpdesk",
  description: "Front desk.",
  permissions: { admin: ["access", "users"], user: ["list", "get"], session: [] },
  builtin: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleCache();
  mocks.createMany.mockResolvedValue({ count: BUILTIN_ROLES.length });
  mocks.findMany.mockResolvedValue([supportRow]);
});

describe("role cache", () => {
  it("seeds the built-in roles once, then reads the table", async () => {
    const roles = await loadRoleDefinitions();

    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining(
        BUILTIN_ROLES.map((role) => expect.objectContaining({ name: role.name })),
      ),
      skipDuplicates: true,
    });
    expect(roles.map((role) => role.name)).toEqual(["support"]);

    await refreshRoleDefinitions();
    await refreshRoleDefinitions();
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
  });

  it("normalizes stored permissions and defaults malformed ones to empty", async () => {
    mocks.findMany.mockResolvedValue([
      { ...supportRow, permissions: { admin: ["users", "bogus"], user: "list" } },
    ]);

    const [role] = await loadRoleDefinitions();

    expect(role?.permissions).toEqual({ admin: ["access", "users"], user: [], session: [] });
  });

  it("keeps the plugin's role map in step with writes", async () => {
    await loadRoleDefinitions();
    expect(AUTH_ROLES.helpdesk).toBeUndefined();

    mocks.findMany.mockResolvedValue([supportRow, helpdeskRow]);
    await refreshRoleDefinitions();

    const helpdesk = AUTH_ROLES.helpdesk;
    expect(helpdesk).toBeDefined();
    expect(helpdesk?.authorize({ admin: ["users"] }).success).toBe(true);
    expect(helpdesk?.authorize({ user: ["delete"] }).success).toBe(false);
  });

  it("drops a role from the plugin map once its row is gone", async () => {
    mocks.findMany.mockResolvedValue([supportRow, helpdeskRow]);
    await loadRoleDefinitions();
    expect(AUTH_ROLES.helpdesk).toBeDefined();

    mocks.findMany.mockResolvedValue([supportRow]);
    await refreshRoleDefinitions();
    expect(AUTH_ROLES.helpdesk).toBeUndefined();
  });

  it("falls back to the built-in seeds when the table cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findMany.mockRejectedValue(new Error("db down"));

    const roles = await loadRoleDefinitions();

    expect(roles.map((role) => role.name)).toEqual(BUILTIN_ROLES.map((role) => role.name));
    expect(error).toHaveBeenCalled();
    expect(AUTH_ROLES.admin?.authorize({ admin: ["access"] }).success).toBe(true);
    error.mockRestore();
  });

  it("shares one read between concurrent callers", async () => {
    await Promise.all([loadRoleDefinitions(), loadRoleDefinitions(), loadRoleDefinitions()]);

    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("reads the table again on the next call, so a role added elsewhere is seen", async () => {
    await loadRoleDefinitions();
    mocks.findMany.mockResolvedValue([supportRow, helpdeskRow]);

    const roles = await loadRoleDefinitions();

    expect(roles.map((role) => role.name)).toContain("helpdesk");
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });
});
