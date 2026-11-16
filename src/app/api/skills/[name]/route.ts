import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { evictUserSessions } from "@/lib/pi/agent-pool";
import { removeGlobalSkill } from "@/lib/skills/global";

/**
 * DELETE /api/skills/:name. remove an installed skill.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { name } = await params;
  const removed = await removeGlobalSkill(userId, name);
  if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A pooled chat built its prompt with the skills it saw then.
  await evictUserSessions(userId);
  return NextResponse.json({ ok: true });
}
