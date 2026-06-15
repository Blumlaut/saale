import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
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

  const settings = await prisma.appSettings.upsert({
    where: { userId: authResult.user.id },
    create: {
      userId: authResult.user.id,
      ...updateData,
    },
    update: updateData,
  });

  return NextResponse.json({ settings: serializeSettings(settings) });
}
