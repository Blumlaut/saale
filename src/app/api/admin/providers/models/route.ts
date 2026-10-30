import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth";
import { buildAdminModelList } from "@/lib/pi/models";
import {
  configuredLimits,
  parseModelCapabilityMap,
  type ModelCapabilityMap,
} from "@/lib/providers/capabilities";
import { definesProviderModels } from "@/lib/providers/config";
import { readEndpointRows } from "@/lib/providers/endpoint";

/**
 * GET /api/admin/providers/models. List every model the *global* provider
 * configuration could offer, for the admin page that enables or disables them
 * for every user.
 *
 * Deliberately unfiltered: a model the admin switched off has to stay in this
 * list to be switched back on.
 */
export async function GET() {
  const authResult = await requirePermission("admin", "providers");
  if (!authResult.ok) return authResult.response;

  const [{ models: available, modelRuntime }, endpoints] = await Promise.all([
    buildAdminModelList(),
    readEndpointRows({ kind: "global" }),
  ]);

  // What the admin set per model on each global endpoint, so the editor can tell
  // an override from an inherited value.
  const storedByProvider = new Map<string, ModelCapabilityMap>(
    endpoints.map((endpoint) => [
      endpoint.provider,
      parseModelCapabilityMap(endpoint.modelCapabilities),
    ]),
  );

  // Group by provider
  const models: Record<
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

  for (const m of available) {
    const overrides = configuredLimits(storedByProvider.get(m.provider) ?? {}, m.id);
    const list = (models[m.provider] ??= []);
    list.push({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning ?? false,
      vision: m.vision,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      ...(definesProviderModels(m.provider) && Object.keys(overrides).length > 0
        ? { overrides }
        : {}),
    });
  }

  const providers = Object.keys(models).map((id) => ({
    id,
    name: modelRuntime.getProvider(id)?.name ?? id,
    modelCount: (models[id] ?? []).length,
    modelsConfigurable: definesProviderModels(id),
  }));

  return NextResponse.json({
    models,
    providers,
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
