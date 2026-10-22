/**
 * Role definitions and permission checks.
 *
 * `User.role` holds role names (better-auth splits on commas, so an account may
 * hold several). A role is two things at once:
 * - the admin-plugin grants (`user`/`session`), which is what the plugin's own
 *   `/admin/*` endpoints check before they act;
 * - the Saale admin slices it may open, which is what the admin panel and the
 *   app's own admin routes check.
 *
 * The rows live in the `Role` table; `BUILTIN_ROLES` is only the seed and the
 * fallback when the table has not been read yet. Client-safe: the navs and the
 * admin screens authorize against a definition list the server hands them.
 */

import { defaultStatements } from "better-auth/plugins/admin/access";
import type { Role } from "better-auth/plugins/access";
import type { Prisma } from "@prisma/client";
import { ADMIN_ACTIONS, saaleAccessControl, type PermissionResource } from "./statements";

export const USER_ACTIONS = [...defaultStatements.user] as const;
export const SESSION_ACTIONS = [...defaultStatements.session] as const;

/** The grants a role carries, matching the access-control statement resources. */
export interface RolePermissions {
  admin: string[];
  user: string[];
  session: string[];
}

export interface RoleDefinition {
  /** Stored on the user record; immutable once created. */
  name: string;
  label: string;
  description: string;
  permissions: RolePermissions;
  /** Seeded from code: cannot be deleted, and `admin`/`user` cannot be edited. */
  builtin: boolean;
}

/** Sections of the admin panel, as the statements' `admin` resource sees them. */
export const ADMIN_SECTION_DEFINITIONS: Record<string, { label: string; description: string }> = {
  access: { label: "Admin panel", description: "Open the admin panel at all." },
  users: { label: "Users", description: "Accounts, roles and feature switches." },
  roles: { label: "Roles", description: "Create, edit and delete roles." },
  models: { label: "Models", description: "Default models and purpose assignments." },
  providers: { label: "Providers", description: "Provider connections and API keys." },
  settings: { label: "Settings", description: "Instance settings and the Telegram bot." },
  plugins: { label: "Plugins", description: "Global Pi plugins: states, updates and logs." },
  telegram: { label: "Telegram", description: "The shared Telegram bot." },
};

export const USER_ACTION_DEFINITIONS: Record<string, { label: string; description: string }> = {
  list: { label: "List accounts", description: "See every account in the panel." },
  get: { label: "View an account", description: "Open an account's details." },
  create: { label: "Create accounts", description: "Add new accounts." },
  update: { label: "Edit accounts", description: "Change names and usernames." },
  delete: { label: "Delete accounts", description: "Remove accounts for good." },
  "set-role": { label: "Change roles", description: "Assign a role to an account." },
  "set-password": { label: "Reset passwords", description: "Set a new password for an account." },
  "set-email": { label: "Change email", description: "Move an account to another address." },
  ban: { label: "Ban accounts", description: "Block and unblock sign-in." },
  impersonate: { label: "Impersonate", description: "Act as a regular account." },
  "impersonate-admins": { label: "Impersonate admins", description: "Act as another admin." },
};

export const SESSION_ACTION_DEFINITIONS: Record<string, { label: string; description: string }> = {
  list: { label: "List sessions", description: "See where an account is signed in." },
  revoke: { label: "Revoke a session", description: "Sign one device out." },
  delete: { label: "Delete sessions", description: "Remove session records." },
};

/** The JSON shape stored in `Role.permissions`. */
export function storedPermissions(permissions: RolePermissions): Prisma.InputJsonObject {
  return permissions as unknown as Prisma.InputJsonObject;
}

/** Role ids are URL segments and user-record values, so keep them boring. */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;

/** The two roles that anchor the model and cannot be edited or deleted. */
export const IMMUTABLE_ROLES = ["admin", "user"] as const;

const ALL_USER_ACTIONS = [...USER_ACTIONS];
const ALL_SESSION_ACTIONS = [...SESSION_ACTIONS];

/**
 * Seeded into the `Role` table on first read, and kept as the fallback for a
 * process that has not loaded the table yet.
 *
 * Only the two anchors ship: everything else is created by an admin. `admin` is
 * the only role in the plugin's `adminRoles`, so it is the only one that can be
 * impersonated or is treated as an admin user by the plugin.
 */
export const BUILTIN_ROLES: readonly RoleDefinition[] = [
  {
    name: "admin",
    label: "Admin",
    description: "Everything: accounts, roles, providers, settings and impersonation.",
    builtin: true,
    permissions: {
      admin: [...ADMIN_ACTIONS],
      user: ALL_USER_ACTIONS,
      session: ALL_SESSION_ACTIONS,
    },
  },
  {
    name: "user",
    label: "User",
    description: "The default role: their own account, and nothing in the admin panel.",
    builtin: true,
    permissions: { admin: [], user: [], session: [] },
  },
];

/** Drop unknown actions and duplicates, keeping the statement order. */
export function normalizeRolePermissions(value: unknown): RolePermissions {
  const source =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const admin = pickActions(source.admin, ADMIN_ACTIONS);
  // A section grant is useless without the panel itself, so it comes along.
  if (admin.length > 0 && !admin.includes("access")) admin.unshift("access");
  return {
    admin,
    user: pickActions(source.user, USER_ACTIONS),
    session: pickActions(source.session, SESSION_ACTIONS),
  };
}

function pickActions(value: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const action of known) if (value.includes(action)) out.push(action);
  return out;
}

/** Merge the grants of every role an account holds. */
export function mergeRolePermissions(
  definitions: readonly RoleDefinition[],
  role: string,
): RolePermissions {
  const merged: RolePermissions = { admin: [], user: [], session: [] };
  for (const name of splitRoles(role)) {
    const definition = definitions.find((entry) => entry.name === name);
    if (!definition) continue;
    for (const resource of ["admin", "user", "session"] as const) {
      for (const action of definition.permissions[resource]) {
        if (!merged[resource].includes(action)) merged[resource].push(action);
      }
    }
  }
  return merged;
}

/** Whether the account holds a grant. */
export function hasGrant(
  permissions: RolePermissions,
  resource: PermissionResource,
  action: string,
): boolean {
  // A malformed payload must hide controls, never crash a nav.
  return permissions[resource]?.includes(action) ?? false;
}

/** Whether any role the account holds grants this action. */
export function roleAllows(
  definitions: readonly RoleDefinition[],
  role: string,
  resource: PermissionResource,
  action: string,
): boolean {
  return hasGrant(mergeRolePermissions(definitions, role), resource, action);
}

/** The label to show for a role name, falling back to the name itself. */
export function roleLabel(definitions: readonly RoleDefinition[], name: string): string {
  return definitions.find((entry) => entry.name === name)?.label ?? name;
}

/** Whether the role string includes the plugin-admin role. */
export function isAdminRole(role: string): boolean {
  return splitRoles(role).includes("admin");
}

/** Whether the account may open the admin panel at all. */
export function roleHasAdminAccess(definitions: readonly RoleDefinition[], role: string): boolean {
  return roleAllows(definitions, role, "admin", "access");
}

/** Whether the role can be edited at all (the two anchors cannot). */
export function isRoleEditable(name: string): boolean {
  return !(IMMUTABLE_ROLES as readonly string[]).includes(name);
}

/** A role as better-auth's admin plugin consumes it. */
export function buildAccessRole(permissions: RolePermissions): Role {
  return saaleAccessControl.newRole(
    permissions as unknown as Parameters<typeof saaleAccessControl.newRole>[0],
  );
}

/** Role names in a stored role string, trimmed and without blanks. */
export function splitRoles(role: string): string[] {
  return role
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}
