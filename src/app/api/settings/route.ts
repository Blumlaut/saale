import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeThinkingLevelSetting } from "@/lib/pi/thinking-levels";
import { normalizeToolExposure, toolExposureEquals } from "@/lib/pi/tool-exposure";
import { evictUserSessions } from "@/lib/pi/agent-pool";
import type { AppSettings } from "@prisma/client";

/** Fields that may be updated via PATCH /api/settings. */
const ALLOWED_FIELDS = new Set([
  "defaultModelProvider",
  "defaultModelName",
  "defaultThinkingLevel",
  "theme",
  "agentCustomInstructions",
  "emailWritingStyle",
  "purposeModelOverrides",
  "disabledModels",
  "defaultToolConfig",
  "toolPolicies",
  "toolExposure",
]);

/** Serialize AppSettings to the shape sent to the frontend. */
function serializeSettings(settings: AppSettings) {
  return {
    defaultModelProvider: settings.defaultModelProvider,
    defaultModelName: settings.defaultModelName,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    theme: settings.theme,
    agentCustomInstructions: settings.agentCustomInstructions,
    emailWritingStyle: settings.emailWritingStyle,
    purposeModelOverrides: settings.purposeModelOverrides,
    disabledModels: settings.disabledModels,
    defaultToolConfig: settings.defaultToolConfig,
    toolPolicies: settings.toolPolicies,
    toolExposure: normalizeToolExposure(settings.toolExposure),
  };
}

/**
 * GET /api/settings — Get user settings
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  let settings = await prisma.appSettings.findUnique({
    where: { userId: authResult.user.id },
  });

  // Create default settings if not exists
  if (!settings) {
    settings = await prisma.appSettings.create({
      data: {
        userId: authResult.user.id,
      },
    });
  }

  return NextResponse.json({ settings: serializeSettings(settings) });
}

/**
 * PATCH /api/settings — Update user settings
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  // Whitelist: only allow known fields (prevents arbitrary field injection)
  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_FIELDS.has(key)) {
      updateData[key] = value;
    }
  }

  // An unknown level would silently mean "no thinking override" — store the
  // fallback instead so the setting always reflects what a user chose.
  if ("defaultThinkingLevel" in updateData) {
    updateData.defaultThinkingLevel = normalizeThinkingLevelSetting(
      updateData.defaultThinkingLevel,
    );
  }

  // Exposure is JSON from a client: keep only known categories/exposures, and
  // drop `direct` entries so the stored row stays sparse.
  let exposureChanged = false;
  if ("toolExposure" in updateData) {
    const normalized = normalizeToolExposure(updateData.toolExposure);
    updateData.toolExposure = normalized;
    const current = await prisma.appSettings.findUnique({
      where: { userId: authResult.user.id },
      select: { toolExposure: true },
    });
    exposureChanged = !toolExposureEquals(normalizeToolExposure(current?.toolExposure), normalized);
  }

  const settings = await prisma.appSettings.upsert({
    where: { userId: authResult.user.id },
    create: {
      userId: authResult.user.id,
      ...updateData,
    },
    update: updateData,
  });

  // A pooled chat's tool loadout is fixed when its agent is built, so a change
  // to exposure only reaches a chat that is already open once its session is
  // rebuilt. Sessions with a run in flight are left alone.
  if (exposureChanged) await evictUserSessions(authResult.user.id);

  return NextResponse.json({ settings: serializeSettings(settings) });
}
