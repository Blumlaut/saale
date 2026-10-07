import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { deleteChatSessions } from "@/lib/chat/delete-session";

/** A batch this large is a client bug, not a workflow — refuse before the loop. */
const MAX_BATCH = 100;

const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_BATCH),
});

/**
 * POST /api/chat/sessions/bulk — Delete several chats in one request.
 *
 * POST rather than DELETE because the ids travel in the request body. Every id
 * is resolved per user inside `deleteChatSessions`, which reports the ids that
 * were removed and the ones that were not (nonexistent, or someone else's).
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Bulk chat delete: request body is not JSON:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Expected an 'ids' array of 1-${MAX_BATCH} chat ids` },
      { status: 400 },
    );
  }

  const result = await deleteChatSessions(authResult.user.id, parsed.data.ids);
  return NextResponse.json(result);
}
