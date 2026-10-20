import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { requireSession } from "@/lib/auth";
import { buildModelRuntime } from "@/lib/pi/models";
import { isPiThinkingLevel } from "@/lib/pi/thinking-levels";

/**
 * GET /api/models/thinking-levels — Returns available thinking levels for a model.
 * ?provider=anthropic&model=claude-sonnet-4-20250514&level=medium
 *
 * `level` is optional: when given, the response carries what Pi would actually
 * run for it, so the UI can say where an unsupported level lands instead of
 * reimplementing Pi's clamping.
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

  const level = searchParams.get("level");

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
    ...(isPiThinkingLevel(level) ? { clampedLevel: clampThinkingLevel(model, level) } : {}),
  });
}
