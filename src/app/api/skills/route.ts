import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/api-body";
import { requireSession } from "@/lib/auth";
import { installGlobalSkill, listGlobalSkills } from "@/lib/skills/global";
import { evictUserSessions } from "@/lib/pi/agent-pool";

/** Either the skill's own text, or an address to read it from. */
const installSkillSchema = z
  .object({
    markdown: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .refine((body) => Boolean(body.markdown ?? body.url), {
    message: "Paste the skill's SKILL.md, or give an address to read it from",
  });

/**
 * GET /api/skills. the skills this account installed, as every chat reads them.
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ skills: await listGlobalSkills(authResult.user.id) });
}

/**
 * POST /api/skills. install a skill, or replace one of the same name.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const body = await readJsonBody(request, installSkillSchema);
  if (!body.ok) return body.response;

  const result = await installGlobalSkill(userId, body.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  // A pooled chat built its prompt with the skills it saw then.
  await evictUserSessions(userId);
  return NextResponse.json({ skill: result.skill }, { status: 201 });
}
