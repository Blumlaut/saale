import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { listRecentChats, serializeRecentChats } from "@/lib/coder/projects";
import { getActiveSessions } from "@/lib/redis";

/** The window the landing page opens with, and the widest it can ask for. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 100;

function readLimit(raw: string | null): number {
  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * GET /api/coder/chats: the user's coder chats across every project.
 *
 * `limit` is the window the landing page shows. "Show more" asks for a wider
 * one, so there is no cursor to lose when a chat is deleted or used between
 * two reads. `isGenerating` comes from Redis, the same source the chat list
 * uses.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const limit = readLimit(new URL(request.url).searchParams.get("limit"));

  try {
    const [recent, generating] = await Promise.all([
      listRecentChats(authResult.user.id, limit),
      getActiveSessions(authResult.user.id),
    ]);
    return NextResponse.json(serializeRecentChats(recent.chats, recent.hasMore, generating));
  } catch (err) {
    console.error("Failed to list recent coder chats:", err);
    return NextResponse.json({ error: "Failed to list chats" }, { status: 500 });
  }
}
