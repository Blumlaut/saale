import { NextRequest, NextResponse } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { unregisterActiveSession } from "@/lib/redis";
import { get, getPoolKey } from "@/lib/pi/agent-pool";

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

  if (!authResult.session.processingSince) {
    return NextResponse.json({ error: "No active generation to stop" }, { status: 400 });
  }

  // Abort the running agent via the agent pool
  const poolKey = getPoolKey(authResult.userId, sessionId);
  const pooled = get(poolKey);
  if (pooled) {
    pooled.session.abort();
    // Don't remove from pool — let it be reused for the next message
    // (eviction handles cleanup)
  }

  // Clear Redis tracking (works across instances)
  await unregisterActiveSession(authResult.userId, sessionId);

  // Clear processing flag so the user can send a new message
  await prisma.chatSession
    .update({
      where: { id: sessionId },
      data: { processingSince: null },
    })
    .catch((err) => {
      console.error("Failed to clear processingSince on stop:", err);
    });

  return NextResponse.json({ stopped: true });
}
