import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { requireSession } from "@/lib/auth";
import { buildModelRuntime } from "@/lib/pi/models";

/**
 * GET /api/models/thinking-levels — Returns available thinking levels for a model.
 * ?provider=anthropic&model=claude-sonnet-4-20250514
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const searchParams = request.nextUrl.searchParams;
  const provider = searchParams.get("provider");
  const modelId = searchParams.get("model");

  if (!provider || !modelId) {
    return NextResponse.json({ error: "Missing provider or model parameter" }, { status: 400 });
  }

  const { modelRuntime } = await buildModelRuntime(authResult.user.id);
  const model = modelRuntime.getModel(provider, modelId);

  if (!model) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }

  const availableLevels = getSupportedThinkingLevels(model);

  return NextResponse.json({
    provider,
    model: modelId,
    reasoning: model.reasoning,
    levels: availableLevels,
  });
}
