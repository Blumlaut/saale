import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/chat/sessions — List user's chat sessions
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const sessions = await prisma.chatSession.findMany({
    where: { userId: authResult.user.id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      messageCount: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    sessions: sessions.map(
      (s: {
        id: string;
        title: string;
        messageCount: number;
        modelProvider: string | null;
        modelName: string | null;
        thinkingLevel: string;
        createdAt: Date;
        updatedAt: Date;
      }) => ({
        id: s.id,
        title: s.title,
        messageCount: s.messageCount,
        modelProvider: s.modelProvider,
        modelName: s.modelName,
        thinkingLevel: s.thinkingLevel,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }),
    ),
  });
}

/**
 * POST /api/chat/sessions — Create a new chat session
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { title, modelProvider, modelName, thinkingLevel } = body;

  const chatSession = await prisma.chatSession.create({
    data: {
      userId: authResult.user.id,
      title: title || "New Chat",
      modelProvider,
      modelName,
      thinkingLevel: thinkingLevel || "off",
    },
  });

  return NextResponse.json({
    session: {
      id: chatSession.id,
      title: chatSession.title,
      createdAt: chatSession.createdAt.toISOString(),
    },
  });
}
