import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { GithubApiError } from "@/lib/integrations/github-app-client";
import {
  GithubAppError,
  applyGithubRepositoryChoices,
  readGithubRepositoryChoices,
} from "@/lib/integrations/github-app";

/**
 * Which repositories one installation covers.
 *
 * This is the fine-graining the GitHub App exists for: the installation is the
 * ceiling GitHub enforces, and the account picks inside it here rather than on
 * GitHub's install page. Both calls run with the account's own token, so GitHub
 * checks that this person may actually change the installation — Saale decides
 * nothing on its own.
 *
 * An installation granted "All repositories" cannot be narrowed through the API
 * (GitHub only removes from a "selected" one); the answer says so and the card
 * explains what to switch on GitHub.
 */

const SAVE_BODY = z.object({
  installationId: z.string().min(1),
  repositoryIds: z.array(z.string().min(1)).max(100),
});

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
    return NextResponse.json(await readGithubRepositoryChoices(authResult.user.id, installationId));
  } catch (err) {
    return failure(err, "read the installation's repositories");
  }
}

/** PUT /api/integrations/github/repositories: set the set, by id. */
export async function PUT(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse the GitHub repository selection body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SAVE_BODY.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Send an installation id and a list of repository ids." },
      { status: 400 },
    );
  }

  try {
    return NextResponse.json(
      await applyGithubRepositoryChoices(
        authResult.user.id,
        parsed.data.installationId,
        parsed.data.repositoryIds,
      ),
    );
  } catch (err) {
    return failure(err, "change the installation's repositories");
  }
}
