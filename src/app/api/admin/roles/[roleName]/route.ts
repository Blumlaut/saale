import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getRoleAccess } from "@/lib/permissions/check";
import { refreshRoleDefinitions } from "@/lib/permissions/role-cache";
import {
  hasGrant,
  isRoleEditable,
  normalizeRolePermissions,
  splitRoles,
  storedPermissions,
  type RolePermissions,
} from "@/lib/permissions/roles";

const updateBodySchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    description: z.string().trim().max(200),
    permissions: z.unknown(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

function ungrantableGrant(caller: RolePermissions, requested: RolePermissions): string | null {
  for (const resource of ["admin", "user", "session"] as const) {
    for (const action of requested[resource]) {
      if (!hasGrant(caller, resource, action)) return `${resource}:${action}`;
    }
  }
  return null;
}

type Params = { params: Promise<{ roleName: string }> };

/** Accounts holding the role, so a delete can explain itself. */
async function holders(roleName: string): Promise<number> {
  const users = await prisma.user.findMany({ select: { role: true } });
  return users.filter((user) => splitRoles(user.role).includes(roleName)).length;
}

/**
 * PATCH /api/admin/roles/[roleName]. edit a role's label, description or grants.
 *
 * The name is the value stored on user records, so it never changes; the two
 * anchor roles (`admin`, `user`) cannot be edited at all.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const authResult = await requirePermission("admin", "roles");
  if (!authResult.ok) return authResult.response;

  const { roleName } = await params;
  if (!isRoleEditable(roleName)) {
    return NextResponse.json({ error: "This role cannot be edited" }, { status: 400 });
  }

  const body = await request.json().catch(() => undefined);
  const parsed = updateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const existing = await prisma.role.findUnique({ where: { name: roleName } });
  if (!existing) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }

  const data: Prisma.RoleUpdateInput = {};
  if (parsed.data.label !== undefined) data.label = parsed.data.label;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;

  if (parsed.data.permissions !== undefined) {
    const permissions = normalizeRolePermissions(parsed.data.permissions);
    const caller = await getRoleAccess(authResult.user.id);
    const excess = ungrantableGrant(caller.permissions, permissions);
    if (excess) {
      return NextResponse.json(
        { error: `Your role does not hold ${excess}, so it cannot grant it` },
        { status: 403 },
      );
    }
    data.permissions = storedPermissions(permissions);
  }

  const role = await prisma.role.update({ where: { name: roleName }, data });
  await refreshRoleDefinitions();

  return NextResponse.json({
    role: {
      name: role.name,
      label: role.label,
      description: role.description,
      permissions: normalizeRolePermissions(role.permissions),
      builtin: role.builtin,
    },
  });
}

/** DELETE /api/admin/roles/[roleName]. remove an unused custom role. */
export async function DELETE(_request: NextRequest, { params }: Params) {
  const authResult = await requirePermission("admin", "roles");
  if (!authResult.ok) return authResult.response;

  const { roleName } = await params;
  const existing = await prisma.role.findUnique({ where: { name: roleName } });
  if (!existing) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }
  if (existing.builtin) {
    return NextResponse.json({ error: "Built-in roles cannot be deleted" }, { status: 400 });
  }

  const held = await holders(roleName);
  if (held > 0) {
    return NextResponse.json(
      {
        error: `Still assigned to ${held} account${held === 1 ? "" : "s"}. move them to another role first`,
      },
      { status: 409 },
    );
  }

  await prisma.role.delete({ where: { name: roleName } });
  await refreshRoleDefinitions();

  return NextResponse.json({ ok: true });
}
