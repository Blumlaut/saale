import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { remoteDefaultBranch } from "@/lib/coder/git";

/**
 * POST /api/coder/projects/default-branch. the branch a remote checks out.
 *
 * The setup flow asks this before the project exists, so a new project's branch
 * field can name the real one instead of guessing. An unreachable or private
 * remote answers with `branch: null`: the field keeps its fallback and the
 * clone is where the truth lands.
 */
const probeSchema = z.object({
  cloneUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => !/\s/.test(value), "A clone URL cannot contain whitespace"),
});

export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json().catch((err: unknown) => {
    console.error("Unreadable default branch request body:", err);
    return null;
  });
  const parsed = probeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { cloneUrl }" }, { status: 400 });
  }

  try {
    const branch = await remoteDefaultBranch(authResult.user.id, parsed.data.cloneUrl);
    return NextResponse.json({ branch });
  } catch (err) {
    console.error(`Failed to probe ${parsed.data.cloneUrl} for its default branch:`, err);
    return NextResponse.json({ error: "Could not reach the remote" }, { status: 502 });
  }
}
