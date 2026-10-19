import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { loadUserFeatures, setUserFeatures } from "@/lib/permissions/features";
import { FEATURES } from "@/lib/permissions/statements";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const authResult = await requirePermission("admin", "users");
  if (!authResult.ok) return authResult.response;
  const { userId } = await params;
  const features = await loadUserFeatures(userId);
  return NextResponse.json({ features });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const authResult = await requirePermission("admin", "users");
  if (!authResult.ok) return authResult.response;
  const { userId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const features = (body as { features?: Record<string, boolean> })?.features;
  if (!features || typeof features !== "object") {
    return NextResponse.json({ error: "features object required" }, { status: 400 });
  }
  const cleaned: Record<string, boolean> = {};
  for (const f of FEATURES) {
    if (typeof features[f] === "boolean") cleaned[f] = features[f];
  }
  await setUserFeatures(userId, cleaned);
  const updated = await loadUserFeatures(userId);
  return NextResponse.json({ features: updated });
}
