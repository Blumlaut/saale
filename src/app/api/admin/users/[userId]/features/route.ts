import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  loadDefaultFeatures,
  loadUserFeatures,
  sparseFeatureOverrides,
} from "@/lib/permissions/feature-access";
import { FEATURES } from "@/lib/permissions/features";
import { isAdminRole } from "@/lib/permissions/roles";
import { setUserFeatures } from "@/lib/settings/update";

const featurePatchSchema = z.object({
  /** The effective feature set the admin saw in the editor. */
  features: z.partialRecord(z.enum(FEATURES), z.boolean()),
});

/** The target account, or null for an id nobody holds. */
async function findTarget(userId: string): Promise<{ role: string } | null> {
  return prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const authResult = await requirePermission("admin", "users");
  if (!authResult.ok) return authResult.response;

  const { userId } = await params;
  const target = await findTarget(userId);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  return NextResponse.json({
    features: await loadUserFeatures(userId),
    readOnly: isAdminRole(target.role),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const authResult = await requirePermission("admin", "users");
  if (!authResult.ok) return authResult.response;

  const { userId } = await params;
  const target = await findTarget(userId);
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (isAdminRole(target.role)) {
    return NextResponse.json({ error: "Admins always have every feature" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = featurePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid features" }, { status: 400 });
  }

  // Store only the switches that differ from the instance defaults, so the
  // account keeps following later default changes for everything untouched.
  const defaults = await loadDefaultFeatures();
  await setUserFeatures(userId, sparseFeatureOverrides(parsed.data.features, defaults));

  return NextResponse.json({ features: await loadUserFeatures(userId), readOnly: false });
}
