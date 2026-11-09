import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { githubStatus, signOutGithub, startGithubLogin } from "@/lib/coder/github";
import {
  GithubAppError,
  forgetGithubAppLogin,
  pollGithubAppLogin,
  readGithubAppCredentials,
  refreshGithubInstallations,
  readGithubAppStatus,
  signOutGithubApp,
  startGithubAppLogin,
} from "@/lib/integrations/github-app";

/**
 * The GitHub connection of one account, in both forms it can take.
 *
 * `app` is this instance's GitHub App: the account authorizes it once with a
 * device code, Saale keeps the token pair and refreshes it, and the installations
 * the account may use come back with the answer.
 *
 * `cli` is the GitHub CLI's own login in the workspace, unchanged: an instance
 * that has no app configured keeps working exactly as before.
 *
 * Both are reported together on purpose. A card that showed only one of them
 * would say "connected" while the other is what a command actually uses; the
 * switch that makes that impossible comes with the workspace side.
 */

/** What the card needs of one source. */
export interface GithubAppSection {
  /** An admin saved an app and left it switched on. */
  configured: boolean;
  /** The app's slug, for the install link GitHub hosts. */
  slug: string | null;
  /** The account authorized it. */
  authorized: { login: string; expiresAt: string | null } | null;
  /** Installations this account may use. */
  installations: {
    installationId: string;
    accountLogin: string;
    accountType: string;
    repositorySelection: string;
    repositories: string[] | null;
    suspended: boolean;
  }[];
  /** A sign-in waiting for the user to type a code. */
  pending: { userCode: string; verificationUri: string; expiresAt: string } | null;
}

/** The app's side of the card, with one poll of a sign-in in flight folded in. */
async function readAppSection(userId: string): Promise<GithubAppSection> {
  const app = await readGithubAppCredentials();
  if (!app?.enabled) {
    return { configured: false, slug: null, authorized: null, installations: [], pending: null };
  }

  // A card that asks for the status is also what drives the sign-in: one poll per
  // request, paced by the interval GitHub named.
  const poll = await pollGithubAppLogin(userId).catch((err: unknown) => {
    console.error(`Failed to poll the GitHub sign-in of ${userId}:`, err);
    return { state: "idle" } as const;
  });

  const status = await readGithubAppStatus(userId);
  // An installation made in a browser tab (the app installed on an organization)
  // is not something this account did inside Saale, so the list is re-read from
  // GitHub rather than trusted from the last sync.
  const installations = status.authorized
    ? await refreshGithubInstallations(userId).catch((err: unknown) => {
        console.error(`Failed to refresh the GitHub installations of ${userId}:`, err);
        return status.installations;
      })
    : status.installations;
  const authorized = status.authorized
    ? {
        login: status.authorized.login,
        expiresAt: status.authorized.expiresAt?.toISOString() ?? null,
      }
    : null;

  if (poll.state === "expired" || poll.state === "denied") {
    return {
      configured: true,
      slug: status.slug,
      authorized,
      installations,
      pending: null,
    };
  }

  return {
    configured: true,
    slug: status.slug,
    authorized,
    installations,
    pending:
      poll.state === "pending" || poll.state === "slow-down"
        ? {
            userCode: poll.login.userCode,
            verificationUri: poll.login.verificationUri,
            expiresAt: poll.login.expiresAt.toISOString(),
          }
        : null,
  };
}

/** GET /api/integrations/github: the app and the CLI, as each of them stands. */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const userId = authResult.user.id;
  return NextResponse.json({
    app: await readAppSection(userId),
    cli: await githubStatus(userId),
  });
}

/**
 * POST /api/integrations/github: open a sign-in.
 *
 * The app first, when the instance has one: its token is the one Saale can
 * refresh and narrow. Without an app, the GitHub CLI's own device flow runs in
 * the workspace exactly as it always did.
 */
export async function POST() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const userId = authResult.user.id;
  const app = await readGithubAppCredentials();

  if (app?.enabled) {
    try {
      const login = await startGithubAppLogin(userId);
      return NextResponse.json({
        app: {
          configured: true,
          slug: app.slug,
          authorized: null,
          installations: [],
          pending: {
            userCode: login.userCode,
            verificationUri: login.verificationUri,
            expiresAt: login.expiresAt.toISOString(),
          },
        } satisfies GithubAppSection,
        cli: await githubStatus(userId),
      });
    } catch (err) {
      if (err instanceof GithubAppError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      console.error(`Failed to start the GitHub App sign-in of ${userId}:`, err);
      return NextResponse.json(
        { error: "The GitHub sign-in could not be started" },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    app: { configured: false, slug: null, authorized: null, installations: [], pending: null },
    cli: await startGithubLogin(userId),
  });
}

/**
 * DELETE /api/integrations/github?source=app|cli: sign out of one of them.
 *
 * `app` is the default when an app is configured, because that is the connection
 * the card offers; the CLI stays reachable with `?source=cli` so an instance with
 * both can still drop the gh login.
 */
export async function DELETE(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const userId = authResult.user.id;
  const source = request.nextUrl.searchParams.get("source");

  // Closing the dialog drops a code nobody is going to approve. It is not a sign
  // out: an account that was connected before stays connected.
  if (request.nextUrl.searchParams.get("cancel") === "1") {
    await forgetGithubAppLogin(userId);
    const app = await readGithubAppCredentials();
    return NextResponse.json({
      app: await readAppSection(userId),
      cli: app?.enabled ? await githubStatus(userId) : await signOutGithub(userId),
    });
  }

  const useApp =
    source === "app" || (source !== "cli" && Boolean((await readGithubAppCredentials())?.enabled));

  if (useApp) {
    await signOutGithubApp(userId);
    return NextResponse.json({
      app: await readAppSection(userId),
      cli: await githubStatus(userId),
    });
  }

  return NextResponse.json({
    app: await readAppSection(userId),
    cli: await signOutGithub(userId),
  });
}
