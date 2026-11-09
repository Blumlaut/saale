import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { forgetGithubInstallationSync } from "@/lib/integrations/github-app";

/**
 * Where GitHub sends the browser back after the app was installed or its
 * repository access was changed.
 *
 * The app's settings page on GitHub takes this URL as its "Setup URL" (with
 * "Redirect on update" ticked), and GitHub calls it with `installation_id` and
 * `setup_action`. Nothing is trusted from those parameters: the installation
 * itself is read back from GitHub with the account's own token, which is the only
 * account that could have installed it. All this route does is clear the
 * one-minute mark that holds a re-read back, and hand the browser to the card.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  await forgetGithubInstallationSync(authResult.user.id);

  return NextResponse.redirect(new URL("/dashboard/settings/integrations", request.nextUrl.origin));
}
