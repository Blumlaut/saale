import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateShareToken } from "@/lib/chat/share";

/**
 * POST /api/chat/sessions/:sessionId/share — Enable sharing for a chat session.
 *
 * Returns the share URL. Idempotent — calling again returns the existing token.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  // Already shared — return existing token
  if (authResult.session.shared && authResult.session.shareToken) {
    return NextResponse.json({
      ok: true,
      shareUrl: `/share/${authResult.session.shareToken}`,
      shareToken: authResult.session.shareToken,
    });
  }

  const token = generateShareToken();

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { shared: true, shareToken: token },
  });

  return NextResponse.json({
    ok: true,
    shareUrl: `/share/${token}`,
    shareToken: token,
  });
}

/**
 * DELETE /api/chat/sessions/:sessionId/share — Disable sharing for a chat session.
 *
 * Clears the share token and sets shared = false.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { shared: false, shareToken: null },
  });

  return NextResponse.json({ ok: true });
}
