import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getRoleAccess } from "@/lib/permissions/check";
import { refreshRoleDefinitions, loadRoleDefinitions } from "@/lib/permissions/role-cache";
import {
  hasGrant,
  normalizeRolePermissions,
  splitRoles,
  storedPermissions,
  ROLE_NAME_PATTERN,
  type RolePermissions,
} from "@/lib/permissions/roles";

const createBodySchema = z.object({
  name: z.string().regex(ROLE_NAME_PATTERN, "lowercase letters, digits and dashes, 2-30 chars"),
  label: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default(""),
  permissions: z.unknown().optional(),
});

/** The first grant the caller does not hold, if any. nobody may grant more than they have. */
function ungrantableGrant(caller: RolePermissions, requested: RolePermissions): string | null {
  for (const resource of ["admin", "user", "session"] as const) {
    for (const action of requested[resource]) {
      if (!hasGrant(caller, resource, action)) return `${resource}:${action}`;
    }
  }
  return null;
}

/** User counts by role name, splitting accounts that hold several roles. */
async function userCountsByRole(): Promise<Map<string, number>> {
  const users = await prisma.user.findMany({ select: { role: true } });
  const counts = new Map<string, number>();
  for (const user of users) {
    for (const name of splitRoles(user.role)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * GET /api/admin/roles. every role the instance knows, built-in or custom.
 *
 * Labels are needed by the users screen too, so reading the list only needs
 * admin-panel access; changing a role needs the roles slice.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "access");
  if (!authResult.ok) return authResult.response;

  const [roles, counts] = await Promise.all([loadRoleDefinitions(), userCountsByRole()]);
  return NextResponse.json({
    roles: roles.map((role) => ({ ...role, userCount: counts.get(role.name) ?? 0 })),
  });
}

/**
 * POST /api/admin/roles. create a custom role.
 *
 * The caller can only hand out grants they hold themselves, so a delegated role
 * manager cannot promote a role (or themselves) above their own reach.
 */
export async function POST(request: NextRequest) {
  const authResult = await requirePermission("admin", "roles");
  if (!authResult.ok) return authResult.response;

  const body = await request.json().catch(() => undefined);
  const parsed = createBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const permissions = normalizeRolePermissions(parsed.data.permissions);
  const caller = await getRoleAccess(authResult.user.id);
  const excess = ungrantableGrant(caller.permissions, permissions);
  if (excess) {
    return NextResponse.json(
      { error: `Your role does not hold ${excess}, so it cannot grant it` },
      { status: 403 },
    );
  }

  const existing = await prisma.role.findUnique({ where: { name: parsed.data.name } });
  if (existing) {
    return NextResponse.json({ error: "A role with that id already exists" }, { status: 409 });
  }

  const role = await prisma.role
    .create({
      data: {
        name: parsed.data.name,
        label: parsed.data.label,
        description: parsed.data.description,
        permissions: storedPermissions(permissions),
        builtin: false,
      },
    })
    .catch((err: unknown) => {
      // Two admins racing the same id: the primary key settles it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
      throw err;
    });
  if (!role) {
    return NextResponse.json({ error: "A role with that id already exists" }, { status: 409 });
  }
  await refreshRoleDefinitions();

  return NextResponse.json(
    {
      role: {
        name: role.name,
        label: role.label,
        description: role.description,
        permissions: normalizeRolePermissions(role.permissions),
        builtin: role.builtin,
        userCount: 0,
      },
    },
    { status: 201 },
  );
}
