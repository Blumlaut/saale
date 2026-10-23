import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { normalizeThinkingLevelSetting } from "@/lib/pi/thinking-levels";
import { createChatSessionRow } from "@/lib/chat/create-session";
import { ownedProjectId } from "@/lib/coder/projects";
import { getActiveSessions } from "@/lib/redis";

/**
 * GET /api/chat/sessions. List user's chat sessions
 *
 * A chat with a `projectId` belongs to a coder project; without the query
 * parameter only normal chats are listed, so coder chats never show up in the
 * chat view. With it, the project's coder chats are listed instead.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");

  const sessions = await prisma.chatSession.findMany({
    where: { userId: authResult.user.id, projectId },
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
 *
 * `projectId` makes it a coder chat. The project is checked against the user
 * here, so a guessed id cannot attach a chat to someone else's repo.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { title, temporary, modelProvider, modelName, thinkingLevel, toolConfig, projectId } = body;

  let ownedProject: string | null = null;
  if (projectId !== undefined && projectId !== null) {
    if (typeof projectId !== "string") {
      return NextResponse.json({ error: "projectId must be a string" }, { status: 400 });
    }
    ownedProject = await ownedProjectId(authResult.user.id, projectId);
    if (!ownedProject) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const chatSession = await createChatSessionRow(authResult.user.id, {
    title,
    temporary: !!temporary,
    modelProvider,
    modelName,
    thinkingLevel: normalizeThinkingLevelSetting(thinkingLevel),
    toolConfig,
    projectId: ownedProject,
  });

  return NextResponse.json({
    session: {
      id: chatSession.id,
      title: chatSession.title,
      createdAt: chatSession.createdAt.toISOString(),
    },
  });
}
