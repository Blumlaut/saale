import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { searchUserMail } from "@/lib/search/sources";

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
      // Account hasn't synced yet. use fallback names
      for (const name of KNOWN_TRASH_FOLDERS) {
        trashNames.add(name);
      }
    }
  }
  return Array.from(trashNames);
}

/** A query-string date, or undefined when it is missing or unparseable. */
function searchDate(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * GET /api/email/messages. List emails across user's accounts
 * Query params: accountId, folder, unread, starred, since, until, limit, offset, search, tag
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const accountId = url.searchParams.get("accountId") ?? undefined;
  const folder = url.searchParams.get("folder") ?? undefined;
  const unread = url.searchParams.get("unread");
  const starred = url.searchParams.get("starred");
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const search = url.searchParams.get("search") ?? "";
  const tag = url.searchParams.get("tag") ?? undefined;

  // The "all" view leaves out each account's trash, which only IMAP knows.
  const excludeFolders = folder
    ? undefined
    : await collectTrashFolders(authResult.user.id, accountId);

  // One past the page says another one follows, where a count would scan the
  // whole mailbox on every scroll.
  const rows = await searchUserMail(authResult.user.id, search, {
    filters: {
      accountId,
      folder,
      excludeFolders,
      unread: unread === "true" ? true : unread === "false" ? false : undefined,
      starred: starred === "true" ? true : starred === "false" ? false : undefined,
      since: searchDate(since),
      until: searchDate(until),
      tag,
    },
    limit: limit + 1,
    offset,
  });

  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;

  return NextResponse.json({
    messages: messages.map((m) => ({
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
    })),
    hasMore,
  });
}
