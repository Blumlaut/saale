import { prisma } from "@/lib/db";
import { FEATURE_ACTIONS } from "./statements";


export type FeatureMap = Record<string, boolean>;

/** All features on — used as the fallback template. */
export function allFeaturesOn(): FeatureMap {
  const out: FeatureMap = {};
  for (const f of FEATURE_ACTIONS) out[f] = true;
  return out;
}

/**
 * Resolve the effective feature set for a user.
 *
 * Admins get everything. Regular users get the instance default
 * (`AdminSettings.featureDefaults`, all-on when unset) overridden by their own
 * sparse `AppSettings.features`.
 */
export async function loadUserFeatures(userId: string): Promise<FeatureMap> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if ((user?.role ?? "user").split(",").some((r) => r.trim() === "admin")) {
    return allFeaturesOn();
  }

  const [admin, userSettings] = await Promise.all([
    prisma.adminSettings.findUnique({ where: { id: "global" }, select: { featureDefaults: true } }),
    prisma.appSettings.findUnique({ where: { userId }, select: { features: true } }),
  ]);

  const base: FeatureMap = { ...allFeaturesOn() };
  const defaults = (admin?.featureDefaults as FeatureMap | null) ?? null;
  if (defaults && typeof defaults === "object") {
    for (const [k, v] of Object.entries(defaults)) {
      if (typeof v === "boolean") base[k] = v;
    }
  }
  const overrides = (userSettings?.features as FeatureMap | null) ?? null;
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === "boolean") base[k] = v;
    }
  }
  return base;
}

export { setUserFeatures, setDefaultFeatures } from "@/lib/settings/update";
