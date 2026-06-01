import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { headers } from "next/headers";
import { buildModelRegistry } from "@/lib/pi/models";

/**
 * GET /api/providers/models — Returns available models based on user's configured providers.
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { models, modelRegistry } = await buildModelRegistry(session.user.id);

  // Group by provider
  const byProvider: Record<
    string,
    Array<{
      id: string;
      name: string;
    }>
  > = {};

  for (const model of models) {
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
    totalModels: models.length,
  });
}
