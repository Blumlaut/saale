import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { councilCaller, councilErrorResponse } from "@/lib/council/http";
import { abortCouncilRun } from "@/lib/council/run";

/**
 * POST /api/council/[councilId]/abort — stop the run that is working.
 *
 * Idempotent: stopping a room that is already quiet reports `stopped: false`
 * rather than failing, because a second press (or a stop that raced the run's
 * own end) is not an error. The request is a flag the loop polls, so this
 * returns before the run has finished — the stream reports when it does.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ councilId: string }> },
) {
  const { councilId } = await params;
  const caller = await councilCaller();
  if (!caller.ok) return caller.response;

  try {
    const stopped = await abortCouncilRun({ councilId, userId: caller.userId });
    return NextResponse.json(
      stopped ? { stopped: true, runId: stopped.runId } : { stopped: false },
    );
  } catch (err) {
    return councilErrorResponse(err, `POST /api/council/${councilId}/abort`);
  }
}
