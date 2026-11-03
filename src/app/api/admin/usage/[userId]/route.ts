import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getUsageDetail } from "@/lib/admin/usage";
import { USAGE_WINDOWS, type UsageWindow } from "@/lib/admin/usage-windows";

/** One account's spend, read when its row is unfolded. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const access = await requirePermission("admin", "usage");
  if (!access.ok) return access.response;

  const requested = Number(request.nextUrl.searchParams.get("days") ?? 30);
  const days = (USAGE_WINDOWS as readonly number[]).includes(requested)
    ? (requested as UsageWindow)
    : 30;

  const { userId } = await params;
  return NextResponse.json(await getUsageDetail(userId, days));
}
