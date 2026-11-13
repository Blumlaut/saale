import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readGithubTokenPrecedence } from "@/lib/integrations/github-credentials";
import { GITHUB_TOKEN_PRECEDENCES } from "@/lib/integrations/github-source";
import { setSetting } from "@/lib/settings/update";
import { getPublicUrl } from "@/lib/public-url";
import {
  GithubAppError,
  deleteGithubApp,
  readGithubAppSummary,
  readGithubAppSummaryFresh,
  saveGithubApp,
  setGithubAppEnabled,
} from "@/lib/integrations/github-app";

/**
 * The instance's GitHub App.
 *
 * Admin-scoped, because the app is instance infrastructure: its private key and
 * client secret decide what every workspace may do on GitHub, and one account
 * must not be able to point them somewhere else. The secrets never come back out
 * — reads carry the app's identity and state, which is all the form needs.
 *
 * Saving verifies the credentials against GitHub before they are stored, so a
 * wrong app id or key fails here rather than in the first chat that trusted the
 * card.
 */

const SAVE_BODY = z.object({
  appId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  privateKey: z.string(),
});

const PATCH_BODY = z
  .object({
    enabled: z.boolean().optional(),
    tokenPrecedence: z.enum(GITHUB_TOKEN_PRECEDENCES).optional(),
  })
  .refine((body) => body.enabled !== undefined || body.tokenPrecedence !== undefined, {
    message: "Nothing to change",
  });

/**
 * The URLs an admin has to paste into GitHub's form.
 *
 * Derived from the instance's own public URL rather than typed by hand, because
 * a wrong Setup URL silently leaves the card on "install it" forever.
 */
function registrationUrls() {
  const base = getPublicUrl();
  return {
    publicUrl: base,
    callbackUrl: `${base}/api/integrations/github/callback`,
    setupUrl: `${base}/api/integrations/github/installed`,
  };
}

/**
 * How far the instance is through its own setup.
 *
 * The admin's view: the app is saved, some accounts have authorized it, some
 * accounts are installed. A number that stays at zero is the answer to "why does
 * the card still say install it".
 */
async function setupProgress() {
  const [accounts, installations] = await Promise.all([
    prisma.githubUserToken.count(),
    prisma.githubInstallation.count({ where: { suspendedAt: null } }),
  ]);
  return { connectedAccounts: accounts, installations };
}

/** GET /api/admin/github/app: the app, or null when none is saved. */
export async function GET() {
  const authResult = await requirePermission("admin", "github");
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({
    // Fresh permissions, so the panel's verdict on the app is GitHub's current
    // one rather than what was saved last.
    app: await readGithubAppSummaryFresh(),
    ...registrationUrls(),
    ...(await setupProgress()),
    tokenPrecedence: await readGithubTokenPrecedence(),
  });
}

/** PUT /api/admin/github/app: save a credential set GitHub accepts. */
export async function PUT(request: NextRequest) {
  const authResult = await requirePermission("admin", "github");
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse the GitHub App credentials body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SAVE_BODY.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "All four fields are needed: app id, client id, client secret, private key." },
      { status: 400 },
    );
  }

  try {
    const app = await saveGithubApp({ ...parsed.data, adminUserId: authResult.user.id });
    return NextResponse.json({ app });
  } catch (err) {
    // A credential GitHub refused is the admin's input, not a server fault.
    if (err instanceof GithubAppError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Failed to save the GitHub App credentials:", err);
    return NextResponse.json(
      { error: "GitHub could not be reached to verify these credentials." },
      { status: 502 },
    );
  }
}

/** PATCH /api/admin/github/app: switch the app on or off. */
export async function PATCH(request: NextRequest) {
  const authResult = await requirePermission("admin", "github");
  if (!authResult.ok) return authResult.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse the GitHub App toggle body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PATCH_BODY.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Send 'enabled' and/or 'tokenPrecedence'." },
      { status: 400 },
    );
  }

  const existing = await readGithubAppSummary();
  if (!existing) {
    return NextResponse.json({ error: "No GitHub App is configured" }, { status: 404 });
  }

  try {
    if (parsed.data.enabled !== undefined) await setGithubAppEnabled(parsed.data.enabled);
    if (parsed.data.tokenPrecedence !== undefined) {
      // The registry is the only write path for an admin setting, and it checks
      // the admin role again on the way in.
      await setSetting(
        authResult.user.id,
        "admin.githubTokenPrecedence",
        parsed.data.tokenPrecedence,
      );
    }
  } catch (err) {
    console.error("Failed to change the GitHub App settings:", err);
    return NextResponse.json({ error: "The setting could not be saved" }, { status: 500 });
  }

  return NextResponse.json({
    app: await readGithubAppSummary(),
    tokenPrecedence: await readGithubTokenPrecedence(),
  });
}

/**
 * DELETE /api/admin/github/app: forget the app, its installations and the tokens
 * every account authorized with it.
 */
export async function DELETE() {
  const authResult = await requirePermission("admin", "github");
  if (!authResult.ok) return authResult.response;

  await deleteGithubApp();
  return NextResponse.json({ app: null });
}
