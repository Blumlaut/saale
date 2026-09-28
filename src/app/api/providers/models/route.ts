import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildModelRuntime } from "@/lib/pi/models";
import { definesProviderModels } from "@/lib/providers/config";

/**
 * GET /api/providers/models — Returns available models based on user's configured providers.
 * ?includeDisabled=true — include disabled models (for settings page)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const searchParams = request.nextUrl.searchParams;
  const { models, modelRuntime } = await buildModelRuntime(authResult.user.id);

  // Load disabled models for this user
  const settings = await prisma.appSettings.findUnique({
    where: { userId: authResult.user.id },
    select: { disabledModels: true },
  });
  const disabledSet = new Set((settings?.disabledModels as string[] | null) ?? []);

  // Filter out disabled models (unless ?includeDisabled=true)
  const includeDisabled = searchParams.get("includeDisabled") === "true";
  const displayModels = includeDisabled
    ? models
    : models.filter((m) => !disabledSet.has(`${m.provider}:${m.id}`));

  // Group by provider, carrying the fields the model pickers render with
  // (thinking badge, image support, context size).
  const byProvider: Record<
    string,
    Array<{
      id: string;
      name: string;
      reasoning: boolean;
      vision: boolean;
      contextWindow: number | undefined;
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
      reasoning: model.reasoning ?? false,
      vision: model.vision,
      contextWindow: "contextWindow" in model ? model.contextWindow : undefined,
    });
  }

  const providers = Object.keys(byProvider).map((p) => ({
    id: p,
    name: modelRuntime.getProvider(p)?.name ?? p,
    modelCount: (byProvider[p] ?? []).length,
    // Whether this provider's per-model metadata is Saale's to record, so the
    // settings UI knows where a capability is editable at all.
    modelsConfigurable: definesProviderModels(p),
  }));

  return NextResponse.json({
    providers,
    models: byProvider,
    totalModels: displayModels.length,
    disabledModels: Array.from(disabledSet),
  });
}
