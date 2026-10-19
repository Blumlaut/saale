"use client";

import { useSessionRole } from "@/hooks/use-session-role";
import { roleHasAdminAccess } from "@/lib/permissions/roles";

/** Whether the signed-in account may open the admin panel; false until the session is checked. */
export function useIsAdmin(): boolean {
  const role = useSessionRole();
  return role ? roleHasAdminAccess(role) : false;
}
