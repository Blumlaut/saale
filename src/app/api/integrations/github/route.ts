import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { validateGitHubToken } from "@/lib/github";

/**
 * GET /api/integrations/github — Get user's GitHub integration status
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const account = await prisma.gitHubAccount.findUnique({
    where: { userId: authResult.user.id },
    select: {
      id: true,
      enabled: true,
      username: true,
      avatarUrl: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!account) {
    return NextResponse.json({ account: null });
  }

  return NextResponse.json({
    account: {
      id: account.id,
      enabled: account.enabled,
      username: account.username,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    },
  });
}

/**
 * POST /api/integrations/github — Create or update GitHub integration
 * Body: { token: string }
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const token = body.token as string;

  if (!token || typeof token !== "string" || token.trim().length < 10) {
    return NextResponse.json({ error: "Invalid GitHub token" }, { status: 400 });
  }

  const trimmedToken = token.trim();

  try {
    // Validate the token by calling GitHub's /user endpoint
    const userInfo = await validateGitHubToken(trimmedToken);

    // Encrypt the token
    const encryptedToken = encrypt(trimmedToken);

    // Upsert the account
    const account = await prisma.gitHubAccount.upsert({
      where: { userId: authResult.user.id },
      create: {
        userId: authResult.user.id,
        encryptedToken,
        username: userInfo.login,
        avatarUrl: userInfo.avatarUrl,
        enabled: true,
      },
      update: {
        encryptedToken,
        username: userInfo.login,
        avatarUrl: userInfo.avatarUrl,
        enabled: true,
      },
    });

    return NextResponse.json({
      account: {
        id: account.id,
        enabled: account.enabled,
        username: account.username,
        avatarUrl: account.avatarUrl,
        createdAt: account.createdAt.toISOString(),
        updatedAt: account.updatedAt.toISOString(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to validate GitHub token";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * PATCH /api/integrations/github — Update GitHub integration (enable/disable)
 * Body: { enabled: boolean }
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const enabled = body.enabled as boolean | undefined;

  if (enabled === undefined) {
    return NextResponse.json({ error: "Missing 'enabled' field" }, { status: 400 });
  }

  const account = await prisma.gitHubAccount.findUnique({
    where: { userId: authResult.user.id },
  });

  if (!account) {
    return NextResponse.json({ error: "No GitHub integration found" }, { status: 404 });
  }

  const updated = await prisma.gitHubAccount.update({
    where: { id: account.id },
    data: { enabled },
    select: {
      id: true,
      enabled: true,
      username: true,
      avatarUrl: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({
    account: {
      id: updated.id,
      enabled: updated.enabled,
      username: updated.username,
      avatarUrl: updated.avatarUrl,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/integrations/github — Remove GitHub integration
 */
export async function DELETE() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const account = await prisma.gitHubAccount.findUnique({
    where: { userId: authResult.user.id },
  });

  if (!account) {
    return NextResponse.json({ error: "No GitHub integration found" }, { status: 404 });
  }

  await prisma.gitHubAccount.delete({
    where: { id: account.id },
  });

  return NextResponse.json({ success: true });
}
