import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
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
 * `preview` runs the consent resolution without saving, so the dialog can show
 * what the script would be allowed to call before the user commits to it.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = (await request.json()) as Record<string, unknown>;

  try {
    if (body.preview === true) {
      const preview = await previewConsent({
        userId: authResult.user.id,
        script: typeof body.script === "string" ? body.script : "",
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      });
      return NextResponse.json({ preview });
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
