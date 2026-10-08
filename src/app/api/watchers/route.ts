import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { previewScript } from "@/lib/watchers/tick";
import {
  createWatcher,
  previewConsent,
  serializeWatcher,
  WatcherInputError,
} from "@/lib/watchers/manage";

/**
 * GET /api/watchers — the user's script watchers.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const watchers = await prisma.scriptWatcher.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "desc" },
    include: { session: { select: { title: true } } },
  });

  return NextResponse.json({ watchers: watchers.map(serializeWatcher) });
}

/**
 * POST /api/watchers — create a watcher.
 *
 * With `preview`, nothing is saved: the caller gets the consent list the script
 * would need, and with `run` the script is also executed once so the user can
 * see what it actually returns before committing a schedule to it. That is the
 * authoring loop, and it is the user's own hand on it — the API is the same act
 * of consent as the dialog they are looking at.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = (await request.json()) as Record<string, unknown>;

  try {
    if (body.preview === true) {
      const script = typeof body.script === "string" ? body.script : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;

      const preview = await previewConsent({ userId: authResult.user.id, script, sessionId });
      if (body.run !== true) return NextResponse.json({ preview });

      const outcome = await previewScript({ userId: authResult.user.id, script, sessionId });
      return NextResponse.json({ preview, outcome });
    }

    const created = await createWatcher({
      userId: authResult.user.id,
      fields: {
        name: body.name,
        description: body.description,
        script: body.script,
        cronExpression: body.cronExpression,
        sessionId: body.sessionId,
        wakePrompt: body.wakePrompt,
        modelId: body.modelId,
        cooldownMinutes: body.cooldownMinutes,
        enabled: body.enabled,
      },
    });

    // Read it back so the client gets the stored row, not an echo of the input.
    const watcher = await prisma.scriptWatcher.findUniqueOrThrow({
      where: { id: created.id },
      include: { session: { select: { title: true } } },
    });

    return NextResponse.json({ watcher: serializeWatcher(watcher) }, { status: 201 });
  } catch (err) {
    if (err instanceof WatcherInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
