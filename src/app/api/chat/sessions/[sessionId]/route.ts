import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/chat/sessions/:sessionId — Get session details
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: {
      id: true,
      title: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      messageCount: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    session: {
      ...chatSession,
      createdAt: chatSession.createdAt.toISOString(),
      updatedAt: chatSession.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/chat/sessions/:sessionId — Update session (title, model, etc.)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { title, modelProvider, modelName, thinkingLevel, toolConfig } = body;

  const updated = await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      ...(title && { title }),
      ...(modelProvider && { modelProvider }),
      ...(modelName && { modelName }),
      ...(thinkingLevel && { thinkingLevel }),
      ...(toolConfig && { toolConfig }),
    },
  });

  return NextResponse.json({
    session: {
      id: updated.id,
      title: updated.title,
      modelProvider: updated.modelProvider,
      modelName: updated.modelName,
      thinkingLevel: updated.thinkingLevel,
      toolConfig: updated.toolConfig,
    },
  });
}

/**
 * DELETE /api/chat/sessions/:sessionId — Delete a session and all its messages
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
  });

  if (!chatSession) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.chatSession.delete({
    where: { id: sessionId },
  });

  return NextResponse.json({ ok: true });
}
