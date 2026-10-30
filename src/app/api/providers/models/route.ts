import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildModelRuntime } from "@/lib/pi/models";
import {
  configuredLimits,
  parseModelCapabilityMap,
  type ModelCapabilityMap,
} from "@/lib/providers/capabilities";
import { definesProviderModels } from "@/lib/providers/config";
import { readEndpointRows } from "@/lib/providers/endpoint";

/**
 * GET /api/providers/models. Returns available models based on user's configured providers.
 * ?includeDisabled=true. include disabled models (for settings page)
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const searchParams = request.nextUrl.searchParams;
  const [{ models, modelRuntime }, endpoints] = await Promise.all([
    buildModelRuntime(authResult.user.id),
    readEndpointRows({ kind: "user", userId: authResult.user.id }),
  ]);

  // What the user set per model on each endpoint, so the editor can tell an
  // override from an inherited value.
  const storedByProvider = new Map<string, ModelCapabilityMap>(
    endpoints.map((endpoint) => [
      endpoint.provider,
      parseModelCapabilityMap(endpoint.modelCapabilities),
    ]),
  );

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
      maxOutputTokens: number | undefined;
      overrides?: { contextWindow?: number; maxOutputTokens?: number };
    }>
  > = {};

  for (const model of displayModels) {
    const provider = model.provider;
    if (!byProvider[provider]) {
      byProvider[provider] = [];
    }
    const overrides = configuredLimits(storedByProvider.get(provider) ?? {}, model.id);
    byProvider[provider]!.push({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      vision: model.vision,
      contextWindow: "contextWindow" in model ? model.contextWindow : undefined,
      maxOutputTokens: model.maxOutputTokens,
      ...(definesProviderModels(provider) && Object.keys(overrides).length > 0
        ? { overrides }
        : {}),
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
    // Per endpoint: the defaults a model's own value falls back to.
    endpointLimits: Object.fromEntries(
      endpoints
        .filter((endpoint) => endpoint.baseUrl)
        .map((endpoint) => [
          endpoint.provider,
          { contextWindow: endpoint.contextWindow, maxOutputTokens: endpoint.maxOutputTokens },
        ]),
    ),
  });
}
