import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { compactChatSession, type CompactChatErrorCode } from "@/lib/chat/compact-chat";

/** HTTP mapping for the compaction failure reasons — see `compactChatSession`. */
const ERROR_STATUS: Record<CompactChatErrorCode, number> = {
  "no-model": 400,
  "already-compacted": 409,
  "nothing-to-compact": 409,
  failed: 500,
};

const ERROR_CODE: Partial<Record<CompactChatErrorCode, string>> = {
  "already-compacted": "already_compacted",
  "nothing-to-compact": "nothing_to_compact",
};

/**
 * POST /api/chat/sessions/:sessionId/compact — manually compact the conversation.
 *
 * The work lives in `compactChatSession` so the `/compact` slash command
 * compacts a chat exactly the same way.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  const result = await compactChatSession({ userId: authResult.userId, sessionId });
  if (!result.ok) {
    const code = ERROR_CODE[result.code];
    return NextResponse.json(
      { error: code ?? result.message, message: result.message },
      { status: ERROR_STATUS[result.code] },
    );
  }

  return NextResponse.json({ compacted: true, tokensBefore: result.tokensBefore });
}
