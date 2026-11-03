/**
 * Route guards for pages behind a feature or an admin slice.
 *
 * A hidden nav item is not access control: the URL is still reachable, so a
 * page the account may not use has to stop itself. The API routes behind it
 * check the same permission.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { hasFeature, hasPermission, getRoleAccess, type RoleAccess } from "./check";
import { hasGrant } from "./roles";
import type { FeatureKey } from "./features";
import type { AdminAction } from "./statements";

async function currentUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

/** Send the caller back to chat unless their role holds this admin slice. */
export async function requireAdminSection(action: AdminAction): Promise<void> {
  const userId = await currentUserId();
  if (!userId || !(await hasPermission(userId, "admin", action))) {
    redirect("/dashboard/chat");
  }
}

/**
 * Send the caller back to chat unless their role holds one of these slices, and
 * hand back the grants so the page can show only the sections it may open.
 */
export async function requireAnyAdminSection(actions: readonly AdminAction[]): Promise<RoleAccess> {
  const userId = await currentUserId();
  const access = userId ? await getRoleAccess(userId) : null;
  const allowed =
    access !== null && actions.some((action) => hasGrant(access.permissions, "admin", action));
  if (!access || !allowed) {
    redirect("/dashboard/chat");
  }
  return access;
}

/** Send the caller back to chat unless the feature is switched on for them. */
export async function requireFeaturePage(feature: FeatureKey): Promise<void> {
  const userId = await currentUserId();
  if (!userId || !(await hasFeature(userId, feature))) {
    redirect("/dashboard/chat");
  }
}
