import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { buildModelRegistry } from "@/lib/pi/models";

/**
 * GET /api/providers/models — Returns available models based on user's configured providers.
 * ?includeDisabled=true — include disabled models (for settings page)
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const { models, modelRegistry } = await buildModelRegistry(session.user.id);

  // Load disabled models for this user
  const settings = await prisma.appSettings.findUnique({
    where: { userId: session.user.id },
    select: { disabledModels: true },
  });
  const disabledSet = new Set((settings?.disabledModels as string[] | null) ?? []);

  // Filter out disabled models (unless ?includeDisabled=true)
  const includeDisabled = searchParams.get("includeDisabled") === "true";
  const displayModels = includeDisabled
    ? models
    : models.filter((m) => !disabledSet.has(`${m.provider}:${m.id}`));

  // Group by provider
  const byProvider: Record<
    string,
    Array<{
      id: string;
      name: string;
    }>
  > = {};

  for (const model of displayModels) {
    const provider = model.provider;
    if (!byProvider[provider]) {
      byProvider[provider] = [];
    }
    byProvider[provider]!.push({
      id: model.id,
      name: model.name,
    });
  }

  const providers = Object.keys(byProvider).map((p) => ({
    id: p,
    name: modelRegistry.getProviderDisplayName(p),
    modelCount: (byProvider[p] ?? []).length,
  }));

  return NextResponse.json({
    providers,
    models: byProvider,
    totalModels: displayModels.length,
    disabledModels: Array.from(disabledSet),
  });
}
