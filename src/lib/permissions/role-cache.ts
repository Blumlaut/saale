/**
 * The role table, cached per process.
 *
 * better-auth's admin plugin authorizes synchronously at request time, so the
 * plugin is handed one map that this module keeps in step with the database —
 * `loadRoleDefinitions()` is awaited by the auth hook before any auth request
 * runs, and the role API refreshes the map the moment a role is written.
 *
 * Reads are not cached across requests: Next gives every route its own module
 * instance, so a write can only invalidate the copy in the bundle that served
 * it. A short TTL therefore showed newly created roles to the API while a page
 * bundle still refused them.
 */

import type { Role } from "better-auth/plugins/access";
import { prisma } from "@/lib/db";
import {
  BUILTIN_ROLES,
  buildAccessRole,
  normalizeRolePermissions,
  storedPermissions,
  type RoleDefinition,
} from "./roles";

let definitions: RoleDefinition[] = [...BUILTIN_ROLES];
let inFlight: Promise<RoleDefinition[]> | null = null;
let seeded = false;

/** The live map the admin plugin authorizes against; rebuilt in place. */
export const AUTH_ROLES: Record<string, Role> = {};

function rebuildAuthRoles(next: readonly RoleDefinition[]): void {
  for (const name of Object.keys(AUTH_ROLES)) delete AUTH_ROLES[name];
  for (const definition of next)
    AUTH_ROLES[definition.name] = buildAccessRole(definition.permissions);
}

rebuildAuthRoles(definitions);

interface RoleRow {
  name: string;
  label: string;
  description: string;
  permissions: unknown;
  builtin: boolean;
}

function toDefinition(row: RoleRow): RoleDefinition {
  return {
    name: row.name,
    label: row.label,
    description: row.description,
    permissions: normalizeRolePermissions(row.permissions),
    builtin: row.builtin,
  };
}

async function readRoles(): Promise<RoleDefinition[]> {
  if (!seeded) {
    await prisma.role.createMany({
      data: BUILTIN_ROLES.map((role) => ({
        name: role.name,
        label: role.label,
        description: role.description,
        permissions: storedPermissions(role.permissions),
        builtin: true,
      })),
      skipDuplicates: true,
    });
    seeded = true;
  }
  const rows = await prisma.role.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toDefinition);
}

/** Reload the table now — used after a write so the next check sees it. */
export async function refreshRoleDefinitions(): Promise<RoleDefinition[]> {
  try {
    const next = await readRoles();
    definitions = next;
    rebuildAuthRoles(next);
    return next;
  } catch (err) {
    console.error("Failed to load role definitions:", err);
    return definitions;
  }
}

/** The current role table; concurrent callers share one read. */
export async function loadRoleDefinitions(): Promise<RoleDefinition[]> {
  inFlight ??= refreshRoleDefinitions().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Reset the cache — tests only. */
export function resetRoleCache(): void {
  definitions = [...BUILTIN_ROLES];
  seeded = false;
  inFlight = null;
  rebuildAuthRoles(definitions);
}
