import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import {
  approveWatcherScript,
  deleteWatcher,
  serializeWatcher,
  updateWatcher,
  WatcherInputError,
} from "@/lib/watchers/manage";

/** The watcher, scoped to its owner. never looked up by id alone. */
async function findOwned(userId: string, id: string) {
  return prisma.scriptWatcher.findFirst({ where: { id, userId } });
}

/**
 * GET /api/watchers/[id]. one watcher with its recent ticks.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;
  const watcher = await findOwned(authResult.user.id, id);
  if (!watcher) return NextResponse.json({ error: "Watcher not found" }, { status: 404 });

  const ticks = await prisma.scriptWatcherTick.findMany({
    where: { watcherId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const withSession = await prisma.scriptWatcher.findUniqueOrThrow({
    where: { id },
    include: { session: { select: { title: true } } },
  });

  return NextResponse.json({
    watcher: serializeWatcher(withSession),
    ticks: ticks.map((tick) => ({
      id: tick.id,
      status: tick.status,
      value: tick.value,
      error: tick.error,
      output: tick.output,
      durationMs: tick.durationMs,
      callCount: tick.callCount,
      createdAt: tick.createdAt.toISOString(),
    })),
  });
}

/**
 * PATCH /api/watchers/[id]. edit a watcher.
 *
 * `approveScript` is what the dialog sends once the user has seen the consent
 * list for the script it is saving; without it a script change leaves the grant
 * stale, and the next tick is refused instead of running on an old approval.
 * `approve` alone re-approves the script already stored.
 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;
  const body = (await request.json()) as Record<string, unknown>;

  try {
    const owned = await findOwned(authResult.user.id, id);
    if (!owned) return NextResponse.json({ error: "Watcher not found" }, { status: 404 });

    if (body.approve === true && body.script === undefined) {
      await approveWatcherScript(id, authResult.user.id);
    } else {
      const fields: Record<string, unknown> = {};
      for (const key of [
        "name",
        "description",
        "script",
        "cronExpression",
        "sessionId",
        "wakePrompt",
        "modelId",
        "cooldownMinutes",
        "enabled",
      ]) {
        if (key in body) fields[key] = body[key];
      }

      await updateWatcher({
        id,
        userId: authResult.user.id,
        fields,
        approveScript: body.approveScript === true,
      });
    }

    const watcher = await prisma.scriptWatcher.findUniqueOrThrow({
      where: { id },
      include: { session: { select: { title: true } } },
    });

    return NextResponse.json({ watcher: serializeWatcher(watcher) });
  } catch (err) {
    if (err instanceof WatcherInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

/**
 * DELETE /api/watchers/[id]. remove a watcher and stop its ticks.
 */
export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await context.params;

  try {
    await deleteWatcher(id, authResult.user.id);
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof WatcherInputError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
