import { prisma } from "@/lib/db";
import { SAAL_ROLES } from "./roles";

/** Look up a user's role string (comma-separated). */
export async function getUserRole(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return user?.role ?? "user";
}

/** Whether a role string represents an admin-tier account. */
export function isAdminRole(role: string): boolean {
  return role.split(",").some((r) => r.trim() === "admin");
}

/** Whether the account may access the admin panel at all. */
export async function hasPermission(
  userId: string,
  resource: "admin" | "feature",
  action: string,
): Promise<boolean> {
  const role = await getUserRole(userId);
  // Admins bypass everything.
  if (isAdminRole(role)) return true;
  const roles = role
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  for (const r of roles) {
    const roleObj = (
      SAAL_ROLES as Record<
        string,
        { authorize: (req: Record<string, string[]>) => { success: boolean } }
      >
    )[r];
    if (!roleObj) continue;
    const result = roleObj.authorize({ [resource]: [action] });
    if (result.success) return true;
  }
  return false;
}

/** Convenience: admin panel access. */
export async function isAdminUser(userId: string): Promise<boolean> {
  return hasPermission(userId, "admin", "access");
}

/** Convenience: feature access (admins always true). */
export async function hasFeature(userId: string, feature: string): Promise<boolean> {
  if (await hasPermission(userId, "admin", "access")) return true;
  // Non-admin: resolve from DB feature set.
  const { loadUserFeatures } = await import("./features");
  const features = await loadUserFeatures(userId);
  return features[feature] !== false;
}
