/**
 * Saale permission statements — what a role may do in the admin surface.
 *
 * The `user` and `session` resources are the admin plugin's own statements. They
 * have to be carried over verbatim: passing `ac`/`roles` to the plugin replaces
 * its defaults, and without them every `/admin/*` endpoint refuses with 403.
 *
 * `admin` is Saale's own resource — the slices of the admin panel that can be
 * delegated to a non-admin role.
 *
 * Feature access is not a role grant: features are resolved per account from
 * the instance defaults and per-user overrides (see `feature-access.ts`), so an
 * admin can switch a module on or off without inventing a role for it.
 */

import { defaultStatements } from "better-auth/plugins/admin/access";
import { createAccessControl } from "better-auth/plugins/access";

export const ADMIN_ACTIONS = [
  "access",
  "users",
  "models",
  "providers",
  "settings",
  "telegram",
] as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** Resources the access control knows about. */
export type PermissionResource = "admin" | keyof typeof defaultStatements;

export const SAAL_STATEMENTS = {
  ...defaultStatements,
  admin: ADMIN_ACTIONS,
} as const;

export const saaleAccessControl = createAccessControl(SAAL_STATEMENTS);
