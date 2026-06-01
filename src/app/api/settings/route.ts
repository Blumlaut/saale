import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * GET /api/settings — Get user settings
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let settings = await prisma.appSettings.findUnique({
    where: { userId: session.user.id },
  });

  // Create default settings if not exists
  if (!settings) {
    settings = await prisma.appSettings.create({
      data: {
        userId: session.user.id,
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
    },
  });
}

/**
 * PATCH /api/settings — Update user settings
 */
export async function PATCH(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  const settings = await prisma.appSettings.upsert({
    where: { userId: session.user.id },
    create: {
      userId: session.user.id,
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
    },
  });
}
