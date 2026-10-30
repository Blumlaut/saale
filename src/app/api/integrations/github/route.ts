import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { githubStatus, signOutGithub, startGithubLogin } from "@/lib/coder/github";

/**
 * The GitHub sign-in of a user's workspace, as `gh` sees it.
 *
 * No token passes through here: gh keeps it on the workspace volume and this
 * route only starts the device flow, reads the result and signs out.
 */

/** GET /api/integrations/github: the account, or the sign-in waiting to be approved. */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json(await githubStatus(authResult.user.id));
}

/** POST /api/integrations/github: start a sign-in and answer with the code to type. */
export async function POST() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json(await startGithubLogin(authResult.user.id));
}

/** DELETE /api/integrations/github: stop a sign-in in flight, then sign out. */
export async function DELETE() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  return NextResponse.json(await signOutGithub(authResult.user.id));
}
