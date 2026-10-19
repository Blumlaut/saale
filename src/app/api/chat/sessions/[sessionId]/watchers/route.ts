import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/chat/sessions/:sessionId/watchers — watchers bound to this
 * conversation, for the chat's linked panel.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const watchers = await prisma.scriptWatcher.findMany({
    where: { sessionId, userId: authResult.session.userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      enabled: true,
      cronExpression: true,
      lastTickAt: true,
      lastFiredAt: true,
      lastError: true,
      fireCount: true,
    },
  });

  return NextResponse.json({
    watchers: watchers.map((watcher) => ({
      id: watcher.id,
      name: watcher.name,
      enabled: watcher.enabled,
      cronExpression: watcher.cronExpression,
      lastTickAt: watcher.lastTickAt?.toISOString() ?? null,
      lastFiredAt: watcher.lastFiredAt?.toISOString() ?? null,
      lastError: watcher.lastError,
      fireCount: watcher.fireCount,
    })),
  });
}
