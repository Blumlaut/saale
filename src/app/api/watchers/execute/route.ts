import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { unscheduleWatcher } from "@/lib/queue";
import { runWatcherTick } from "@/lib/watchers/tick";

/**
 * POST /api/watchers/execute
 * Internal endpoint called by the BullMQ worker for a watcher's scheduled tick.
 * Authenticated via x-worker-key header.
 *
 * The watcher is loaded fresh so edits (script, cadence, target) take effect on
 * the next tick. A deleted or disabled watcher has its scheduler removed and the
 * tick skipped, rather than retrying forever.
 */
export async function POST(request: NextRequest) {
  const WORKER_API_KEY = process.env.WORKER_API_KEY ?? "";
  const key = request.headers.get("x-worker-key");

  if (key !== WORKER_API_KEY || !WORKER_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { watcherId?: string };
  const { watcherId } = body;

  if (!watcherId) {
    return NextResponse.json({ error: "watcherId is required" }, { status: 400 });
  }

  const watcher = await prisma.scriptWatcher.findUnique({
    where: { id: watcherId },
    select: { id: true, enabled: true },
  });

  if (!watcher || !watcher.enabled) {
    if (!watcher) {
      console.warn(`[api/watchers/execute] Watcher ${watcherId} not found, removing scheduler.`);
    } else {
      console.warn(`[api/watchers/execute] Watcher ${watcherId} is disabled, removing scheduler.`);
    }
    await unscheduleWatcher(watcherId);
    return NextResponse.json({ success: true, skipped: true });
  }

  try {
    const outcome = await runWatcherTick(watcherId);
    return NextResponse.json({ success: true, outcome });
  } catch (err) {
    // `runWatcherTick` records its own failures; getting here means something
    // outside the tick broke (the database, the settings lookup).
    const message = (err as Error).message;
    console.error(`[api/watchers/execute] Tick for watcher ${watcherId} failed:`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
