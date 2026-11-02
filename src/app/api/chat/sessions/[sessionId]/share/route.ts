import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateShareToken } from "@/lib/chat/share";
import { DEFAULT_SHARE_ACCESS, SHARE_ACCESSES, type ShareAccess } from "@/lib/chat/share-access";

const shareBodySchema = z.object({
  access: z.enum(SHARE_ACCESSES).default(DEFAULT_SHARE_ACCESS),
});

/** The access level a POST asks for, or null when the body is not one. */
async function requestedAccess(request: NextRequest): Promise<ShareAccess | null> {
  const raw = await request.text();
  if (!raw.trim()) return DEFAULT_SHARE_ACCESS;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to read the share request body:", err);
    return null;
  }

  const parsed = shareBodySchema.safeParse(payload);
  if (!parsed.success) {
    console.error("Unknown share access in request:", parsed.error.issues);
    return null;
  }

  return parsed.data.access;
}

/**
 * GET /api/chat/sessions/:sessionId/share. Get current share state.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const access = authResult.session.shareAccess as ShareAccess;

  if (authResult.session.shared && authResult.session.shareToken) {
    return NextResponse.json({
      ok: true,
      isShared: true,
      shareUrl: `/share/${authResult.session.shareToken}`,
      access,
    });
  }

  return NextResponse.json({ ok: true, isShared: false, access });
}

/**
 * POST /api/chat/sessions/:sessionId/share. Enable sharing for a chat session.
 *
 * Returns the share URL. Idempotent: calling again returns the existing token
 * and applies the access level in the body.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const access = await requestedAccess(request);
  if (!access) {
    return NextResponse.json({ error: "Unknown share access" }, { status: 400 });
  }

  // Already shared. keep the token and store the chosen access
  if (authResult.session.shared && authResult.session.shareToken) {
    const token = authResult.session.shareToken;

    if (authResult.session.shareAccess !== access) {
      await prisma.chatSession.updateMany({
        where: { id: sessionId, userId: authResult.userId },
        data: { shareAccess: access },
      });
    }

    return NextResponse.json({
      ok: true,
      shareUrl: `/share/${token}`,
      shareToken: token,
      access,
    });
  }

  const token = generateShareToken();

  await prisma.chatSession.updateMany({
    where: { id: sessionId, userId: authResult.userId },
    data: { shared: true, shareToken: token, shareAccess: access },
  });

  return NextResponse.json({
    ok: true,
    shareUrl: `/share/${token}`,
    shareToken: token,
    access,
  });
}

/**
 * DELETE /api/chat/sessions/:sessionId/share. Disable sharing for a chat session.
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

  await prisma.chatSession.updateMany({
    where: { id: sessionId, userId: authResult.userId },
    data: { shared: false, shareToken: null },
  });

  return NextResponse.json({ ok: true });
}
