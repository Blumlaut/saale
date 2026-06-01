import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * GET /api/chat/sessions — List user's chat sessions
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sessions = await prisma.chatSession.findMany({
    where: { userId: session.user.id },
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
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { title, modelProvider, modelName, thinkingLevel } = body;

  const chatSession = await prisma.chatSession.create({
    data: {
      userId: session.user.id,
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
