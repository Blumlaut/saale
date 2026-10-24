import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { sweepWatcherChats } from "@/lib/watchers/retention";

/**
 * POST /api/watchers/cleanup
 *
 * Internal endpoint the worker calls hourly. It removes the per-fire bot chats
 * whose retention window has passed and whose branch is pushed and clean, and
 * leaves every other one where it is.
 */
export async function POST(request: NextRequest) {
  const workerApiKey = process.env.WORKER_API_KEY ?? "";
  const key = request.headers.get("x-worker-key");
  if (!workerApiKey || key !== workerApiKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sweepWatcherChats();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("[api/watchers/cleanup] Bot chat cleanup failed:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
