import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { queueChatDeletes } from "@/lib/chat/delete-runner";

/** A batch this large is a client bug, not a workflow. refuse before the loop. */
const MAX_BATCH = 100;

const bodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_BATCH),
  force: z.boolean().optional(),
});

/**
 * POST /api/chat/sessions/delete. Delete one chat or several.
 *
 * POST rather than DELETE because the ids travel in the request body, and one
 * route for both because a list that can delete a row and a list that can
 * delete a selection are the same request with a longer list.
 *
 * The removal runs in the background: this marks the chats, so the lists can
 * grey them, and answers with what is on its way out and what a checkout
 * refused. Every id is resolved per user inside `queueChatDeletes`, which
 * reports the ones that are not the user's (or nonexistent) as failures.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Chat delete: request body is not JSON:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Expected an 'ids' array of 1-${MAX_BATCH} chat ids` },
      { status: 400 },
    );
  }

  const result = await queueChatDeletes(
    authResult.user.id,
    parsed.data.ids,
    parsed.data.force === true,
  );
  return NextResponse.json(result);
}
