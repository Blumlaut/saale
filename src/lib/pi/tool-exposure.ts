/**
 * Per-category tool exposure (`AppSettings.toolExposure`) — the server side.
 *
 * The normalization rules live in `tool-exposure-rules.ts` (pure) and are
 * re-exported here so callers keep importing them from one place.
 */

import { prisma } from "@/lib/db";
import { normalizeToolExposure } from "./tool-exposure-rules";
import type { ToolExposureConfig } from "./tool-categories";

export * from "./tool-exposure-rules";

/** Load the user's per-category tool exposure, normalized. */
export async function loadToolExposure(userId: string): Promise<ToolExposureConfig | null> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { toolExposure: true },
  });
  return normalizeToolExposure(settings?.toolExposure);
}
