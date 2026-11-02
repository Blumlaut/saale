import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { markPushSeen } from "@/lib/push/seen";

const seenBodySchema = z.object({
  url: z.string().min(1).max(2048),
});

/**
 * POST /api/push/seen. This browser has a notification's page on screen.
 *
 * Called by the page the user is looking at, and by the service worker when a
 * notification lands on the page it is about or is clicked. A phone's copy that
 * is still waiting is what this drops.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const parsed = seenBodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid notification path" }, { status: 400 });
  }

  await markPushSeen(authResult.user.id, parsed.data.url);

  return NextResponse.json({ ok: true });
}
