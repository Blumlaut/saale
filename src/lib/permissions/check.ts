/**
 * Permission checks against the signed-in user's role (server side).
 *
 * Everything here reads the role fresh: a role can change while a session is
 * open, and a cached answer would let a demoted account keep its access.
 */

import { prisma } from "@/lib/db";
import { loadUserFeatures } from "./feature-access";
import type { FeatureKey } from "./features";
import { loadRoleDefinitions } from "./role-cache";
import { hasGrant, mergeRolePermissions, type RolePermissions } from "./roles";
import type { PermissionResource } from "./statements";

/** Look up a user's role string (comma-separated). */
export async function getUserRole(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role ?? "user";
}

export interface RoleAccess {
  role: string;
  /** Everything the account's roles grant, merged. */
  permissions: RolePermissions;
}

/** The account's role names and the grants they add up to. */
export async function getRoleAccess(userId: string): Promise<RoleAccess> {
  const [role, definitions] = await Promise.all([getUserRole(userId), loadRoleDefinitions()]);
  return { role, permissions: mergeRolePermissions(definitions, role) };
}

/** Whether the account may perform an action on a resource. */
export async function hasPermission(
  userId: string,
  resource: PermissionResource,
  action: string,
): Promise<boolean> {
  const { permissions } = await getRoleAccess(userId);
  return hasGrant(permissions, resource, action);
}

/** Convenience: may the account open the admin panel? */
export async function isAdminUser(userId: string): Promise<boolean> {
  return hasPermission(userId, "admin", "access");
}

/** Whether the account has a feature switched on (admins always do). */
export async function hasFeature(userId: string, feature: FeatureKey): Promise<boolean> {
  const features = await loadUserFeatures(userId);
  return features[feature];
}
