/**
 * Who may use the council module.
 *
 * Two switches, because the module is optional in two different directions:
 *
 * - `COUNCIL_ENABLED=0` (see `flag.ts`) removes it — the nav entry, the routes
 *   and the tools are all gone.
 * - The council costs several models at once and gives them a shared workspace
 *   inside the terminal container, so its feature ships switched off: an admin
 *   turns it on per account.
 *
 * A caller without the feature gets the same 404 as a disabled module: whether
 * the deployment has the feature is not something an unauthorised caller needs
 * to learn.
 */

import { NextResponse } from "next/server";
import { isCouncilEnabled } from "./flag";
import { hasFeature } from "@/lib/permissions/check";

/** The response to send when access is refused, or null when it is allowed. */
export async function requireCouncilAccess(userId: string): Promise<NextResponse | null> {
  if (!isCouncilEnabled() || !(await hasFeature(userId, "council"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

/** Whether this user may see the council nav entry at all. */
export async function canUseCouncil(userId: string): Promise<boolean> {
  return isCouncilEnabled() && (await hasFeature(userId, "council"));
}
