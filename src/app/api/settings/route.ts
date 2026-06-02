import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

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

  return NextResponse.json({
    settings: {
      defaultModelProvider: settings.defaultModelProvider,
      defaultModelName: settings.defaultModelName,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      theme: settings.theme,
      agentSystemPrompt: settings.agentSystemPrompt,
      emailWritingStyle: settings.emailWritingStyle,
      purposeModelOverrides: settings.purposeModelOverrides,
      disabledModels: settings.disabledModels,
    },
  });
}

/**
 * PATCH /api/settings — Update user settings
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  const settings = await prisma.appSettings.upsert({
    where: { userId: authResult.user.id },
    create: {
      userId: authResult.user.id,
      ...body,
    },
    update: body,
  });

  return NextResponse.json({
    settings: {
      defaultModelProvider: settings.defaultModelProvider,
      defaultModelName: settings.defaultModelName,
      defaultThinkingLevel: settings.defaultThinkingLevel,
      theme: settings.theme,
      agentSystemPrompt: settings.agentSystemPrompt,
      emailWritingStyle: settings.emailWritingStyle,
      purposeModelOverrides: settings.purposeModelOverrides,
      disabledModels: settings.disabledModels,
    },
  });
}
