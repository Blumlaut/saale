import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { previewWatcherTick, runWatcherTick } from "@/lib/watchers/tick";

/**
 * POST /api/watchers/[id]/tick — run a watcher once, now.
 *
 * Two modes, because they answer different questions:
 * - `preview: true` (the default) runs the script and reports what it returns
 *   without recording it or waking anyone. This is how a script is written: run
 *   it, look at the result, then decide to schedule it.
 * - `preview: false` is a real tick, recorded and — on a match — delivered.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;

  const watcher = await prisma.scriptWatcher.findFirst({
    where: { id, userId: authResult.user.id },
    select: { id: true },
  });
  if (!watcher) return NextResponse.json({ error: "Watcher not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { preview?: boolean };

  if (body.preview === false) {
    const outcome = await runWatcherTick(id);
    return NextResponse.json({ outcome });
  }

  const outcome = await previewWatcherTick(id);
  return NextResponse.json({ outcome });
}
