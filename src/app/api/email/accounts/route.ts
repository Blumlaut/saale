import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { encrypt } from "@/lib/crypto";

/**
 * GET /api/email/accounts — List user's email accounts
 */
export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await prisma.emailAccount.findMany({
    where: { userId: session.user.id },
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
        cachedFolders: any;
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
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { email, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, password } = body;

  // Validate required fields
  if (!email || !imapHost || !smtpHost || !password) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const encryptedPassword = encrypt(password);

  const account = await prisma.emailAccount.create({
    data: {
      userId: session.user.id,
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

  return NextResponse.json({
    account: {
      id: account.id,
      email: account.email,
      enabled: account.enabled,
      createdAt: account.createdAt.toISOString(),
    },
  });
}
