import { describe, it, expect } from "vitest";
import {
  BUILTIN_ROLES,
  IMMUTABLE_ROLES,
  ROLE_NAME_PATTERN,
  buildAccessRole,
  isAdminRole,
  isRoleEditable,
  mergeRolePermissions,
  normalizeRolePermissions,
  roleAllows,
  roleHasAdminAccess,
  roleLabel,
  type RoleDefinition,
} from "@/lib/permissions/roles";
import { ADMIN_ACTIONS } from "@/lib/permissions/statements";

const allows = (role: string, resource: "admin" | "user" | "session", action: string) =>
  roleAllows(BUILTIN_ROLES, role, resource, action);

describe("built-in roles", () => {
  it("labels and describes every role", () => {
    for (const role of BUILTIN_ROLES) {
      expect(role.label).toBeTruthy();
      expect(role.description).toBeTruthy();
      expect(role.builtin).toBe(true);
    }
  });

  it("gives the admin role every admin slice and the plugin's user actions", () => {
    for (const action of ADMIN_ACTIONS) {
      expect(allows("admin", "admin", action), action).toBe(true);
    }
    // These are what better-auth's /admin/* endpoints check; a custom access
    // control without them makes the users page answer 403 and render empty.
    expect(allows("admin", "user", "list")).toBe(true);
    expect(allows("admin", "user", "create")).toBe(true);
    expect(allows("admin", "user", "set-role")).toBe(true);
    expect(allows("admin", "user", "impersonate")).toBe(true);
    expect(allows("admin", "session", "list")).toBe(true);
  });

  it("lets a user manager manage accounts but not impersonate them", () => {
    expect(allows("user-manager", "admin", "access")).toBe(true);
    expect(allows("user-manager", "admin", "users")).toBe(true);
    expect(allows("user-manager", "user", "list")).toBe(true);
    expect(allows("user-manager", "user", "set-role")).toBe(true);
    expect(allows("user-manager", "user", "impersonate")).toBe(false);
    expect(allows("user-manager", "admin", "models")).toBe(false);
  });

  it("gives support a read-mostly user view", () => {
    expect(allows("support", "user", "list")).toBe(true);
    expect(allows("support", "user", "set-password")).toBe(true);
    expect(allows("support", "user", "create")).toBe(false);
    expect(allows("support", "user", "delete")).toBe(false);
    expect(allows("support", "user", "set-role")).toBe(false);
    expect(allows("support", "admin", "settings")).toBe(true);
    expect(allows("support", "admin", "providers")).toBe(false);
  });

  it("keeps models managers out of accounts", () => {
    expect(allows("models-manager", "admin", "providers")).toBe(true);
    expect(allows("models-manager", "user", "list")).toBe(false);
    expect(allows("models-manager", "admin", "users")).toBe(false);
  });

  it("refuses everything to a plain user", () => {
    expect(roleHasAdminAccess(BUILTIN_ROLES, "user")).toBe(false);
    expect(allows("user", "user", "list")).toBe(false);
  });

  it("honours every role an account holds, and ignores unknown ones", () => {
    expect(allows("support,user-manager", "user", "set-role")).toBe(true);
    expect(allows("user,ghost", "admin", "access")).toBe(false);
    expect(allows("", "admin", "access")).toBe(false);
  });

  it("recognises the plugin-admin role only by name", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("support,admin")).toBe(true);
    expect(isAdminRole("user-manager")).toBe(false);
    expect(isAdminRole(" user ")).toBe(false);
  });

  it("keeps the two anchor roles uneditable", () => {
    expect(IMMUTABLE_ROLES).toContain("admin");
    expect(IMMUTABLE_ROLES).toContain("user");
    expect(isRoleEditable("admin")).toBe(false);
    expect(isRoleEditable("user")).toBe(false);
    expect(isRoleEditable("support")).toBe(true);
    expect(isRoleEditable("helpdesk")).toBe(true);
  });
});

describe("role permissions", () => {
  it("drops unknown actions and duplicates", () => {
    expect(
      normalizeRolePermissions({
        admin: ["users", "users", "nonsense"],
        user: ["list", "nuke"],
        session: ["revoke", "revoke"],
      }),
    ).toEqual({ admin: ["access", "users"], user: ["list"], session: ["revoke"] });
  });

  it("adds panel access to any role that is granted a section", () => {
    expect(normalizeRolePermissions({ admin: ["users"] }).admin).toEqual(["access", "users"]);
    expect(normalizeRolePermissions({ admin: ["settings", "access"] }).admin).toEqual([
      "access",
      "settings",
    ]);
  });

  it("treats a missing or malformed value as no grants", () => {
    expect(normalizeRolePermissions(null)).toEqual({ admin: [], user: [], session: [] });
    expect(normalizeRolePermissions({ admin: "access" })).toEqual({
      admin: [],
      user: [],
      session: [],
    });
  });

  it("merges grants across roles without duplicates", () => {
    const merged = mergeRolePermissions(BUILTIN_ROLES, "support,user-manager");
    expect(merged.admin).toEqual(["access", "users", "settings"]);
    expect(merged.user).toContain("list");
    expect(merged.user.filter((action) => action === "list")).toHaveLength(1);
  });

  it("labels a role by its definition, falling back to the id", () => {
    expect(roleLabel(BUILTIN_ROLES, "support")).toBe("Support");
    expect(roleLabel(BUILTIN_ROLES, "helpdesk")).toBe("helpdesk");
  });

  it("builds a better-auth role that authorizes the same grants", () => {
    const definition: RoleDefinition = {
      name: "helpdesk",
      label: "Helpdesk",
      description: "",
      builtin: false,
      permissions: { admin: ["access", "users"], user: ["list", "get"], session: [] },
    };
    const role = buildAccessRole(definition.permissions);

    expect(role.authorize({ admin: ["users"] }).success).toBe(true);
    expect(role.authorize({ user: ["delete"] }).success).toBe(false);
    expect(role.authorize({ admin: ["access"], user: ["list"] }).success).toBe(true);
  });

  it("only accepts slug-shaped role ids", () => {
    expect(ROLE_NAME_PATTERN.test("helpdesk")).toBe(true);
    expect(ROLE_NAME_PATTERN.test("level-2-support")).toBe(true);
    expect(ROLE_NAME_PATTERN.test("Helpdesk")).toBe(false);
    expect(ROLE_NAME_PATTERN.test("-helpdesk")).toBe(false);
    expect(ROLE_NAME_PATTERN.test("a")).toBe(false);
    expect(ROLE_NAME_PATTERN.test("has space")).toBe(false);
  });
});
