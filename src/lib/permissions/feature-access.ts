/**
 * Resolving an account's feature set (server side).
 *
 * Order: the built-in defaults, overridden by the instance defaults an admin
 * set, overridden by the account's own switches. Admin accounts get everything.
 */

import { prisma } from "@/lib/db";
import {
  allFeatures,
  defaultFeatures,
  FEATURES,
  normalizeFeatureOverrides,
  type FeatureMap,
  type FeatureOverrides,
} from "./features";
import { isAdminRole } from "./roles";

/** Layer override maps over the built-in defaults. */
export function resolveFeatures(...layers: FeatureOverrides[]): FeatureMap {
  const out = defaultFeatures();
  for (const layer of layers) {
    for (const key of FEATURES) {
      const value = layer[key];
      if (typeof value === "boolean") out[key] = value;
    }
  }
  return out;
}

/** The instance defaults: built-in defaults plus the global admin overrides. */
export async function loadDefaultFeatures(): Promise<FeatureMap> {
  const admin = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { featureDefaults: true },
  });
  return resolveFeatures(normalizeFeatureOverrides(admin?.featureDefaults));
}

/** The feature set this account actually gets. */
export async function loadUserFeatures(userId: string): Promise<FeatureMap> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (isAdminRole(user?.role ?? "user")) return allFeatures();

  const [defaults, settings] = await Promise.all([
    loadDefaultFeatures(),
    prisma.appSettings.findUnique({ where: { userId }, select: { features: true } }),
  ]);
  return resolveFeatures(
    normalizeFeatureOverrides(defaults),
    normalizeFeatureOverrides(settings?.features),
  );
}

/**
 * The overrides that turn `baseline` into `wanted` — only the switches that
 * differ are stored, so an account keeps following the instance default for
 * everything an admin did not touch.
 */
export function sparseFeatureOverrides(
  wanted: FeatureOverrides,
  baseline: FeatureMap,
): FeatureOverrides {
  const out: FeatureOverrides = {};
  for (const key of FEATURES) {
    const value = wanted[key];
    if (typeof value === "boolean" && value !== baseline[key]) out[key] = value;
  }
  return out;
}
