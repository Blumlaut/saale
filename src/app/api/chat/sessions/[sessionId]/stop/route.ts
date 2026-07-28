import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { isSessionActive, unregisterActiveSession } from "@/lib/redis";
import { get, getPoolKey } from "@/lib/pi/agent-pool";

/**
 * Explicitly cancel an in-progress generation.
 *
 * Different from client disconnect (navigation/refresh) — this is a user-initiated
 * "stop" that aborts the LLM and clears the active session flag immediately.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  // Idempotent: if not active in Redis, just return.
  // This handles race conditions where the client thinks generation is active
  // but the server already cleared it (e.g., agent_end fired first).
  const isActive = await isSessionActive(authResult.userId, sessionId);

  if (isActive) {
    const poolKey = getPoolKey(authResult.userId, sessionId);
    const pooled = get(poolKey);
    if (pooled) {
      pooled.session.abort();
      // Don't remove from pool — let it be reused for the next message
      // (eviction handles cleanup)
    }

    // Clear Redis tracking (works across instances)
    await unregisterActiveSession(authResult.userId, sessionId);
  }

  return NextResponse.json({ stopped: true });
}
