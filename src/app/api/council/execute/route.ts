import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { WATCHDOG_GRACE_SECONDS } from "@/lib/council/config";
import { isCouncilEnabled } from "@/lib/council/flag";
import { sweepCouncilRuns } from "@/lib/council/run";

/**
 * POST /api/council/execute
 *
 * Internal endpoint called by the BullMQ worker on the council sweep. It rescues
 * runs whose loop died with a restarted app: the row still says `running`, and
 * that status is what holds the council's single run slot, so every later run
 * would be refused until it is released. Authenticated via the `x-worker-key`
 * header, the same as the watcher tick.
 *
 * The grace window is generous relative to the loop's heartbeat (15s): failing a
 * live run would abandon work that is still being done and paid for.
 */
export async function POST(request: NextRequest) {
  if (!isCouncilEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const workerApiKey = process.env.WORKER_API_KEY ?? "";
  const key = request.headers.get("x-worker-key");
  if (!workerApiKey || key !== workerApiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sweepCouncilRuns(WATCHDOG_GRACE_SECONDS * 1000);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[api/council/execute] Council sweep failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
