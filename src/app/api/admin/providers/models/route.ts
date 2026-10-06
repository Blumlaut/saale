import { NextResponse } from "next/server";

import { requireAdmin } from "../../settings/auth";
import { buildGlobalModelRuntime } from "@/lib/pi/models";
import { definesProviderModels } from "@/lib/providers/config";

/**
 * GET /api/admin/providers/models — List the models the *global* provider
 * configuration makes available. Used by the admin models page to enable or
 * disable models for every user.
 */
export async function GET() {
  const authResult = await requireAdmin();
  if (!authResult.ok) return authResult.response;

  const { models: available, modelRuntime } = await buildGlobalModelRuntime();

  // Group by provider
  const models: Record<
    string,
    Array<{ id: string; name: string; reasoning: boolean; vision: boolean }>
  > = {};

  for (const m of available) {
    const list = (models[m.provider] ??= []);
    list.push({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning ?? false,
      vision: m.vision,
    });
  }

  const providers = Object.keys(models).map((id) => ({
    id,
    name: modelRuntime.getProvider(id)?.name ?? id,
    modelCount: (models[id] ?? []).length,
    modelsConfigurable: definesProviderModels(id),
  }));

  return NextResponse.json({ models, providers });
}
