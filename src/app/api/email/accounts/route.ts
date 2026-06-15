import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { syncEmailAccount } from "@/lib/email/sync";

/**
 * GET /api/email/accounts — List user's email accounts
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const accounts = await prisma.emailAccount.findMany({
    where: { userId: authResult.user.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      imapHost: true,
      imapPort: true,
      imapSecure: true,
      smtpHost: true,
      smtpPort: true,
      smtpSecure: true,
      enabled: true,
      lastSyncedAt: true,
      cachedFolders: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { messages: true },
      },
      messages: {
        select: {
          folder: true,
        },
        distinct: ["folder"],
      },
    },
  });

  return NextResponse.json({
    accounts: accounts.map(
      (a: {
        id: string;
        email: string;
        imapHost: string;
        imapPort: number;
        imapSecure: boolean;
        smtpHost: string;
        smtpPort: number;
        smtpSecure: boolean;
        enabled: boolean;
        lastSyncedAt: Date | null;
        cachedFolders: unknown;
        createdAt: Date;
        updatedAt: Date;
        _count: { messages: number };
        messages: { folder: string }[];
      }) => ({
        id: a.id,
        email: a.email,
        imapHost: a.imapHost,
        imapPort: a.imapPort,
        imapSecure: a.imapSecure,
        smtpHost: a.smtpHost,
        smtpPort: a.smtpPort,
        smtpSecure: a.smtpSecure,
        enabled: a.enabled,
        lastSyncedAt: a.lastSyncedAt?.toISOString(),
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        messageCount: a._count.messages,
        folders: a.messages.map((m) => m.folder),
        remoteFolders: (a.cachedFolders as string[]) ?? [],
      }),
    ),
  });
}

/**
 * POST /api/email/accounts — Create a new email account
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { email, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, password } = body;

  // Validate required fields
  if (!email || !imapHost || !smtpHost || !password) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const encryptedPassword = encrypt(password);

  const account = await prisma.emailAccount.create({
    data: {
      userId: authResult.user.id,
      email,
      imapHost,
      imapPort: imapPort ?? 993,
      imapSecure: imapSecure ?? true,
      smtpHost,
      smtpPort: smtpPort ?? 465,
      smtpSecure: smtpSecure ?? true,
      encryptedPassword,
    },
  });

  // Run initial full sync (lastSyncedAt is null, so syncEmailAccount does a full sync)
  const syncResult = await syncEmailAccount(account.id);

  return NextResponse.json({
    account: {
      id: account.id,
      email: account.email,
      enabled: account.enabled,
      createdAt: account.createdAt.toISOString(),
    },
    sync: {
      newMessages: syncResult.newMessages,
      updatedMessages: syncResult.updatedMessages,
      errors: syncResult.errors,
    },
  });
}
