import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { detectModelCapabilities, saveModelCapabilities } from "@/lib/providers/configured";

/**
 * PATCH /api/providers/capabilities. Record what one model can do and how big
 * its window is.
 *
 * Body: `{ provider, modelId, vision?, contextWindow?, maxOutputTokens? }`.
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const owner = { userId: authResult.user.id };
  const outcome = await saveModelCapabilities(owner, await request.json());
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/**
 * POST /api/providers/capabilities. Ask the endpoint what its models can do and
 * store the answers.
 *
 * Detection is explicit rather than part of building the runtime: `/props` costs
 * a request per model, and the runtime is rebuilt for every session, job and
 * Telegram message.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const owner = { userId: authResult.user.id };
  const outcome = await detectModelCapabilities(owner, await request.json());
  return outcome.ok
    ? NextResponse.json(outcome.data)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}
