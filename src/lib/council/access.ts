import { NextResponse } from "next/server";
import { isCouncilEnabled } from "./flag";
import { hasFeature } from "@/lib/permissions/check";

export async function requireCouncilAccess(userId: string): Promise<NextResponse | null> {
  if (!isCouncilEnabled() || !(await hasFeature(userId, "council"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export async function canUseCouncil(userId: string): Promise<boolean> {
  return isCouncilEnabled() && (await hasFeature(userId, "council"));
}
