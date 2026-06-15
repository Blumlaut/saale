import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdmin } from "./auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/admin/settings — Get admin settings
 */
export async function GET() {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  let settings = await prisma.adminSettings.findUnique({
    where: { id: "global" },
  });

  // Create default settings if not exists
  if (!settings) {
    settings = await prisma.adminSettings.create({
      data: { id: "global" },
    });
  }

  return NextResponse.json({
    settings: {
      signupsEnabled: settings.signupsEnabled,
      globalModelProvider: settings.globalModelProvider,
      globalModelName: settings.globalModelName,
      globalProviderModels: settings.globalProviderModels,
    },
  });
}

/**
 * PATCH /api/admin/settings — Update admin settings
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  const allowedFields = new Set([
    "signupsEnabled",
    "globalModelProvider",
    "globalModelName",
    "globalProviderModels",
  ]);

  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowedFields.has(key)) {
      updateData[key] = value;
    }
  }

  const settings = await prisma.adminSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...updateData },
    update: updateData,
  });

  return NextResponse.json({
    settings: {
      signupsEnabled: settings.signupsEnabled,
      globalModelProvider: settings.globalModelProvider,
      globalModelName: settings.globalModelName,
      globalProviderModels: settings.globalProviderModels,
    },
  });
}
