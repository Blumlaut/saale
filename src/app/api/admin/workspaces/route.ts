import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getWorkspaceAudit, startMeasurement } from "@/lib/admin/workspaces";

/**
 * What every workspace holds and is doing.
 *
 * A stale-but-instant answer: the sizes come from the last measurement, and the
 * page asks for a fresh one with `POST` when it opens.
 */
export async function GET(): Promise<NextResponse> {
  const access = await requirePermission("admin", "workspaces");
  if (!access.ok) return access.response;

  return NextResponse.json(await getWorkspaceAudit());
}

/** Start measuring the volume. Answers at once: the walk runs behind the page. */
export async function POST(): Promise<NextResponse> {
  const access = await requirePermission("admin", "workspaces");
  if (!access.ok) return access.response;

  void startMeasurement();
  return NextResponse.json({ measuring: true });
}
