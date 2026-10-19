/**
 * Named role bundles. `User.role` holds one of these names (better-auth splits
 * on commas, so an account may hold several).
 *
 * A role is two things at once:
 * - the admin-plugin grants (`user`/`session`), which is what the plugin's own
 *   `/admin/*` endpoints check before they act;
 * - the Saale admin slices it may open, which is what the admin panel and the
 *   app's own admin routes check.
 *
 * `admin` is the only role in the plugin's `adminRoles`, so it is the only one
 * that can be impersonated or is treated as an admin user by the plugin.
 */

import { defaultStatements } from "better-auth/plugins/admin/access";
import type { Role } from "better-auth/plugins/access";
import { ADMIN_ACTIONS, saaleAccessControl, type PermissionResource } from "./statements";

const { newRole } = saaleAccessControl;

const ALL_USER_ACTIONS = [...defaultStatements.user];
const ALL_SESSION_ACTIONS = [...defaultStatements.session];

/** Account management without impersonation — impersonating is its own power. */
const USER_MANAGER_ACTIONS = ALL_USER_ACTIONS.filter(
  (action) => action !== "impersonate" && action !== "impersonate-admins",
);

export const ROLE_NAMES = ["admin", "models-manager", "user-manager", "support", "user"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const ROLE_LABELS: Record<RoleName, string> = {
  admin: "Admin",
  "models-manager": "Models manager",
  "user-manager": "User manager",
  support: "Support",
  user: "User",
};

export const SAAL_ROLES = {
  admin: newRole({
    admin: [...ADMIN_ACTIONS],
    user: ALL_USER_ACTIONS,
    session: ALL_SESSION_ACTIONS,
  }),
  "models-manager": newRole({
    admin: ["access", "models", "providers", "settings"],
    user: [],
    session: [],
  }),
  "user-manager": newRole({
    admin: ["access", "users"],
    user: USER_MANAGER_ACTIONS,
    session: ["list", "revoke", "delete"],
  }),
  support: newRole({
    admin: ["access", "users", "settings"],
    user: ["list", "get", "set-password"],
    session: ["list"],
  }),
  user: newRole({
    admin: [],
    user: [],
    session: [],
  }),
} as const;

/**
 * Whether any role the account holds grants this action.
 *
 * Client-safe: the navs and admin screens use it to hide what the API would
 * refuse anyway.
 */
export function roleHasAction(role: string, resource: PermissionResource, action: string): boolean {
  const request = { [resource]: [action] } as Record<PermissionResource, string[]>;
  return role
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .some((name) => {
      const entry = (SAAL_ROLES as Record<string, Role | undefined>)[name];
      return entry?.authorize(request).success ?? false;
    });
}

/** Whether the role string includes the plugin-admin role. */
export function isAdminRole(role: string): boolean {
  return role
    .split(",")
    .map((name) => name.trim())
    .includes("admin");
}

/** Whether the account may open the admin panel at all. */
export function roleHasAdminAccess(role: string): boolean {
  return roleHasAction(role, "admin", "access");
}
