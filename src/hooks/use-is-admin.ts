"use client";

import { useSessionPermissions } from "@/hooks/use-session-permissions";
import { hasGrant } from "@/lib/permissions/roles";

/** Whether the signed-in account may open the admin panel; false until the session is checked. */
export function useIsAdmin(): boolean {
  const access = useSessionPermissions();
  return access ? hasGrant(access.permissions, "admin", "access") : false;
}
