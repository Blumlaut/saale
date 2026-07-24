import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { get, getPoolKey } from "@/lib/pi/agent-pool";

/**
 * Manually trigger conversation compaction.
 *
 * This summarizes the conversation history to reduce context usage,
 * freeing up room for more turns without losing key information.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  // Get the pooled session
  const poolKey = getPoolKey(authResult.userId, sessionId);
  const pooled = get(poolKey);
  if (!pooled) {
    return NextResponse.json({ error: "No active session found" }, { status: 404 });
  }

  try {
    const result = await pooled.session.compact();
    return NextResponse.json({
      compacted: true,
      tokensBefore: result?.tokensBefore,
    });
  } catch (err) {
    console.error("Manual compaction failed:", err);
    return NextResponse.json({ error: "Compaction failed" }, { status: 500 });
  }
}
