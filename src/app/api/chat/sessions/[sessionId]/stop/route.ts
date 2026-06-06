import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { unregisterActiveSession } from "@/lib/redis";
import { activeSessions } from "../stream/route";

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
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const { sessionId } = await params;

  // Verify session belongs to user
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: { processingSince: true },
  });

  if (!chatSession?.processingSince) {
    return NextResponse.json({ error: "No active generation to stop" }, { status: 400 });
  }

  // Abort the running agent (same-process only — Redis tracks cross-instance state)
  const session = activeSessions.get(sessionId);
  if (session) {
    session.agent.abort();
    activeSessions.delete(sessionId);
  }

  // Clear Redis tracking (works across instances)
  await unregisterActiveSession(authResult.user.id, sessionId);

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
