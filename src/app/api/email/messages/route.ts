import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/** Fallback trash folder names for accounts that haven't synced yet */
const KNOWN_TRASH_FOLDERS = [
  "Trash",
  "Deleted Messages",
  "Deleted Items",
  "Gelöscht",
  "Papierkorb",
];

/**
 * Collect the actual trash folder names for a user's accounts from the
 * IMAP SPECIAL-USE discovery (`\\Trash` attribute). Falls back to
 * well-known names for accounts that haven't synced yet.
 */
async function collectTrashFolders(userId: string, accountId?: string): Promise<string[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId, ...(accountId ? { id: accountId } : {}) },
    select: { specialFolders: true },
  });
  const trashNames = new Set<string>();
  for (const acc of accounts) {
    const special = acc.specialFolders as Record<string, string | null> | null;
    const trashFolder = special?.["\\Trash"];
    if (trashFolder) {
      trashNames.add(trashFolder);
    } else {
      // Account hasn't synced yet — use fallback names
      for (const name of KNOWN_TRASH_FOLDERS) {
        trashNames.add(name);
      }
    }
  }
  return Array.from(trashNames);
}

/**
 * GET /api/email/messages — List emails across user's accounts
 * Query params: accountId, folder, unread, starred, since, until, limit, offset, search, tag
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId");
  const folder = url.searchParams.get("folder");
  const unread = url.searchParams.get("unread");
  const starred = url.searchParams.get("starred");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const search = url.searchParams.get("search");
  const tag = url.searchParams.get("tag");

  const where: Record<string, unknown> = {
    account: { userId: authResult.user.id },
  };

  if (accountId) {
    where.accountId = accountId;
  }
  if (folder) {
    where.folder = folder;
  } else {
    // "All" view: exclude trash/deleted folders (per-account, from IMAP SPECIAL-USE)
    const trashFolders = await collectTrashFolders(authResult.user.id, accountId ?? undefined);
    if (trashFolders.length > 0) {
      where.NOT = trashFolders.map((name) => ({
        folder: { equals: name, mode: "insensitive" as const },
      }));
    }
  }
  if (tag) {
    where.tags = { has: tag };
  }
  if (unread === "true") {
    where.isRead = false;
  } else if (unread === "false") {
    where.isRead = true;
  }
  if (starred === "true") {
    where.isStarred = true;
  }
  if (since) {
    where.date = where.date || {};
    (where.date as Record<string, unknown>).gte = new Date(since);
  }
  if (until) {
    where.date = where.date || {};
    (where.date as Record<string, unknown>).lt = new Date(until);
  }
  if (search) {
    where.OR = [
      { subject: { contains: search, mode: "insensitive" } },
      { fromEmail: { contains: search, mode: "insensitive" } },
      { fromName: { contains: search, mode: "insensitive" } },
      { bodyPreview: { contains: search, mode: "insensitive" } },
    ];
  }

  const [messages, total] = await Promise.all([
    prisma.emailMessage.findMany({
      where,
      orderBy: { date: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        uid: true,
        fromName: true,
        fromEmail: true,
        to: true,
        subject: true,
        date: true,
        bodyPreview: true,
        isRead: true,
        isStarred: true,
        folder: true,
        tags: true,
        accountId: true,
      },
    }),
    prisma.emailMessage.count({ where }),
  ]);

  return NextResponse.json({
    messages: messages.map(
      (m: {
        id: string;
        uid: string;
        fromName: string | null;
        fromEmail: string;
        to: string;
        subject: string;
        date: Date;
        bodyPreview: string;
        isRead: boolean;
        isStarred: boolean;
        folder: string;
        tags: string[];
        accountId: string;
      }) => ({
        id: m.id,
        uid: m.uid,
        fromName: m.fromName,
        fromEmail: m.fromEmail,
        to: m.to,
        subject: m.subject,
        date: m.date.toISOString(),
        bodyPreview: m.bodyPreview,
        isRead: m.isRead,
        isStarred: m.isStarred,
        folder: m.folder,
        tags: m.tags,
        accountId: m.accountId,
      }),
    ),
    total,
    hasMore: messages.length > 0 && offset + messages.length < total,
  });
}
