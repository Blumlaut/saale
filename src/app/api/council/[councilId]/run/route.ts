import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse, readJsonBody } from "@/lib/council/http";
import { councilRunSchema } from "@/lib/council/schema";
import { startCouncilRun } from "@/lib/council/run";

/**
 * POST /api/council/[councilId]/run. convene the council.
 *
 * The budget in the body applies to *this* run; anything left out falls back to
 * the council's own values and then to the module defaults. `memberIds` is the
 * opening: naming members wakes only them, naming nobody wakes everyone.
 *
 * The run continues after this response. the caller follows it in the room.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  const body = await readJsonBody(request, councilRunSchema);
  if (!body.ok) return body.response;

  try {
    const run = await startCouncilRun({
      councilId,
      userId: caller.userId,
      // Only what the caller named, so an omitted ceiling falls back to the
      // council's own value rather than clearing it.
      budget: {
        ...(body.data.maxDurationSeconds != null
          ? { maxDurationSeconds: body.data.maxDurationSeconds }
          : {}),
        ...(body.data.maxTokens != null ? { maxTokens: body.data.maxTokens } : {}),
        ...(body.data.maxCostUsd != null ? { maxCostUsd: body.data.maxCostUsd } : {}),
      },
      openingMemberIds: body.data.memberIds ?? null,
    });

    return NextResponse.json({ runId: run.runId, running: true }, { status: 202 });
  } catch (err) {
    return councilErrorResponse(err, `POST /api/council/${councilId}/run`);
  }
}
