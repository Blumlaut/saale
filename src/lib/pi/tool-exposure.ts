/**
 * Per-category tool exposure (`AppSettings.toolExposure`).
 *
 * The value is JSON a client can PATCH, and it is read on every session build —
 * so it is normalized in both directions: unknown categories and exposures are
 * dropped on write, and whatever is in the row is validated again on read.
 *
 * `direct` is the default, so entries that say `direct` are omitted rather than
 * stored — the row stays sparse and only holds the categories the user moved
 * behind codemode.
 */

import { prisma } from "@/lib/db";
import {
  isToolExposure,
  TOOL_CATEGORIES,
  type ToolCategoryKey,
  type ToolExposureConfig,
} from "./tool-categories";

const CATEGORY_KEYS = new Set<string>(TOOL_CATEGORIES.map((c) => c.key));

/** Keep only known categories and known exposures; drop `direct` (the default). */
export function normalizeToolExposure(value: unknown): ToolExposureConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const normalized: ToolExposureConfig = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    if (!CATEGORY_KEYS.has(key)) continue;
    if (!isToolExposure(level) || level === "direct") continue;
    normalized[key as ToolCategoryKey] = level;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

/** Load the user's per-category tool exposure, normalized. */
export async function loadToolExposure(userId: string): Promise<ToolExposureConfig | null> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { toolExposure: true },
  });
  return normalizeToolExposure(settings?.toolExposure);
}

/**
 * Whether two exposures are the same setting.
 *
 * Key order is not meaningful (the map is a set of category → level pairs), so
 * a naive `JSON.stringify` comparison would report a change for a reordered
 * object and needlessly evict a user's pooled sessions.
 */
export function toolExposureEquals(
  a: ToolExposureConfig | null | undefined,
  b: ToolExposureConfig | null | undefined,
): boolean {
  const keys = (value: ToolExposureConfig | null | undefined) => Object.keys(value ?? {}).sort();
  const aKeys = keys(a);
  const bKeys = keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => bKeys[index] === key && a![key] === b![key]);
}
