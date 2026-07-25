import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { unregisterActiveSession } from "@/lib/redis";
import { get, getPoolKey } from "@/lib/pi/agent-pool";
import { clearProcessingSince } from "@/lib/pi/processing-state";

/**
 * Explicitly cancel an in-progress generation.
 *
 * Different from client disconnect (navigation/refresh) — this is a user-initiated
 * "stop" that aborts the LLM and clears the processing flag immediately.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return authResult.response;

  // Idempotent: if processingSince is already null, just clear and return.
  // This handles race conditions where the client thinks generation is active
  // but the server already cleared the flag (e.g., agent_end fired first).
  const wasProcessing = !!authResult.session.processingSince;

  // Abort the running agent via the agent pool (only if was processing)
  if (wasProcessing) {
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

  // Always clear processing flag so the user can send a new message
  try {
    await clearProcessingSince(sessionId);
  } catch (err) {
    console.error("Failed to clear processingSince on stop:", err);
  }

  return NextResponse.json({ stopped: true });
}
