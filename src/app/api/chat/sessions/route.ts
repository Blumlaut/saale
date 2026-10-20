import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeThinkingLevelSetting } from "@/lib/pi/thinking-levels";
import { createChatSessionRow } from "@/lib/chat/create-session";
import { getActiveSessions } from "@/lib/redis";

/**
 * GET /api/chat/sessions. List user's chat sessions
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const sessions = await prisma.chatSession.findMany({
    where: { userId: authResult.user.id },
    // Sort by real chat activity (messages sent, title edited). NOT
    // updatedAt, which is bumped by tool state and background jobs.
    orderBy: { lastActivityAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      temporary: true,
      messageCount: true,
      createdAt: true,
      updatedAt: true,
      lastActivityAt: true,
      _count: { select: { scriptWatchers: true } },
    },
  });

  // Source of truth: Redis tracks active generations (ephemeral. cleared on crash).
  const activeSessionIds = await getActiveSessions(authResult.user.id);

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      temporary: s.temporary,
      messageCount: s.messageCount,
      watcherCount: s._count.scriptWatchers,
      isGenerating: activeSessionIds.has(s.id),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
    })),
  });
}

/**
 * POST /api/chat/sessions. Create a new chat session
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { title, temporary, modelProvider, modelName, thinkingLevel, toolConfig } = body;

  const chatSession = await createChatSessionRow(authResult.user.id, {
    title,
    temporary: !!temporary,
    modelProvider,
    modelName,
    thinkingLevel: normalizeThinkingLevelSetting(thinkingLevel),
    toolConfig,
  });

  return NextResponse.json({
    session: {
      id: chatSession.id,
      title: chatSession.title,
      createdAt: chatSession.createdAt.toISOString(),
    },
  });
}
