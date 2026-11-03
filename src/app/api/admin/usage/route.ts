import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getUsageReport } from "@/lib/admin/usage";
import { USAGE_WINDOWS, type UsageWindow } from "@/lib/admin/usage-windows";

/** The window's spend by type, by day and by account. */
export async function GET(request: Request): Promise<NextResponse> {
  const access = await requirePermission("admin", "usage");
  if (!access.ok) return access.response;

  const requested = Number(new URL(request.url).searchParams.get("days") ?? 30);
  const days = (USAGE_WINDOWS as readonly number[]).includes(requested)
    ? (requested as UsageWindow)
    : 30;

  return NextResponse.json(await getUsageReport(days));
}
