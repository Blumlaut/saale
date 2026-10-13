/**
 * Who may use the council module.
 *
 * Two switches, because the module is optional in two different directions:
 *
 * - `COUNCIL_ENABLED=0` (see `flag.ts`) removes it — the nav entry, the routes
 *   and the tools are all gone.
 * - The feature is admin-only. A council runs models in parallel against the
 *   owner's own provider keys and gives them a shared workspace inside the
 *   terminal container, so it is not something every account should switch on.
 *
 * A non-admin gets the same 404 as a disabled module: whether the deployment has
 * the feature is not something an unauthorised caller needs to learn.
 */

import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/settings/update";
import { isCouncilEnabled } from "./flag";

/** The response to send when access is refused, or null when it is allowed. */
export async function requireCouncilAccess(userId: string): Promise<NextResponse | null> {
  if (!isCouncilEnabled() || !(await isAdminUser(userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

/** Whether this user may see the council nav entry at all. */
export async function canUseCouncil(userId: string): Promise<boolean> {
  return isCouncilEnabled() && (await isAdminUser(userId));
}
