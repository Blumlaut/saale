import { describe, it, expect } from "vitest";
import {
  ROLE_LABELS,
  ROLE_NAMES,
  SAAL_ROLES,
  isAdminRole,
  roleHasAction,
  roleHasAdminAccess,
} from "@/lib/permissions/roles";
import { ADMIN_ACTIONS } from "@/lib/permissions/statements";

describe("role bundles", () => {
  it("labels every role", () => {
    for (const name of ROLE_NAMES) {
      expect(ROLE_LABELS[name]).toBeTruthy();
    }
  });

  it("gives the admin role every admin slice and the plugin's user actions", () => {
    for (const action of ADMIN_ACTIONS) {
      expect(roleHasAction("admin", "admin", action), action).toBe(true);
    }
    // These are what better-auth's /admin/* endpoints check; a custom access
    // control without them makes the users page answer 403 and render empty.
    expect(roleHasAction("admin", "user", "list")).toBe(true);
    expect(roleHasAction("admin", "user", "create")).toBe(true);
    expect(roleHasAction("admin", "user", "set-role")).toBe(true);
    expect(roleHasAction("admin", "user", "impersonate")).toBe(true);
    expect(roleHasAction("admin", "session", "list")).toBe(true);
  });

  it("lets a user manager manage accounts but not impersonate them", () => {
    expect(roleHasAction("user-manager", "admin", "access")).toBe(true);
    expect(roleHasAction("user-manager", "admin", "users")).toBe(true);
    expect(roleHasAction("user-manager", "user", "list")).toBe(true);
    expect(roleHasAction("user-manager", "user", "set-role")).toBe(true);
    expect(roleHasAction("user-manager", "user", "impersonate")).toBe(false);
    expect(roleHasAction("user-manager", "admin", "models")).toBe(false);
  });

  it("gives support a read-mostly user view", () => {
    expect(roleHasAction("support", "user", "list")).toBe(true);
    expect(roleHasAction("support", "user", "set-password")).toBe(true);
    expect(roleHasAction("support", "user", "create")).toBe(false);
    expect(roleHasAction("support", "user", "delete")).toBe(false);
    expect(roleHasAction("support", "user", "set-role")).toBe(false);
    expect(roleHasAction("support", "admin", "settings")).toBe(true);
    expect(roleHasAction("support", "admin", "providers")).toBe(false);
  });

  it("keeps models managers out of accounts", () => {
    expect(roleHasAction("models-manager", "admin", "providers")).toBe(true);
    expect(roleHasAction("models-manager", "user", "list")).toBe(false);
    expect(roleHasAction("models-manager", "admin", "users")).toBe(false);
  });

  it("refuses everything to a plain user", () => {
    expect(roleHasAdminAccess("user")).toBe(false);
    expect(roleHasAction("user", "user", "list")).toBe(false);
  });

  it("honours every role an account holds, and ignores unknown ones", () => {
    expect(roleHasAction("support,user-manager", "user", "set-role")).toBe(true);
    expect(roleHasAction("user,ghost", "admin", "access")).toBe(false);
    expect(roleHasAction("", "admin", "access")).toBe(false);
  });

  it("recognises the plugin-admin role only by name", () => {
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("support,admin")).toBe(true);
    expect(isAdminRole("user-manager")).toBe(false);
    expect(isAdminRole(" user ")).toBe(false);
  });

  it("declares the same role names the plugin was configured with", () => {
    expect(Object.keys(SAAL_ROLES).sort()).toEqual([...ROLE_NAMES].sort());
  });
});
