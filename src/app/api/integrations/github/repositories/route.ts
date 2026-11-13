import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { GithubApiError } from "@/lib/integrations/github-app-client";
import { GithubAppError, readGithubInstallationRepositories } from "@/lib/integrations/github-app";

/**
 * Which repositories one installation covers.
 *
 * Read-only on purpose. GitHub's two installation calls (add/remove a
 * repository) refuse a repository the installation does not already cover, and
 * a personal installation cannot be extended over the API at all, so the card
 * shows the set and points at GitHub's page for changing it.
 *
 * An installation granted "All repositories" answers with everything the app may
 * reach; the card says which kind it is next to the count.
 */

/** A GithubAppError is the user's input, a GithubApiError is GitHub's refusal. */
function failure(err: unknown, what: string): NextResponse {
  if (err instanceof GithubAppError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  if (err instanceof GithubApiError) {
    const message =
      err.status === 0 ? "GitHub could not be reached." : `GitHub refused it: ${err.message}`;
    return NextResponse.json({ error: message }, { status: err.status === 0 ? 502 : 400 });
  }
  console.error(`Failed to ${what}:`, err);
  return NextResponse.json({ error: `Failed to ${what}` }, { status: 502 });
}

/** GET /api/integrations/github/repositories?installation=<id> */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const installationId = request.nextUrl.searchParams.get("installation");
  if (!installationId) {
    return NextResponse.json({ error: "Missing 'installation' parameter" }, { status: 400 });
  }

  try {
    return NextResponse.json(
      await readGithubInstallationRepositories(authResult.user.id, installationId),
    );
  } catch (err) {
    return failure(err, "read the installation's repositories");
  }
}
