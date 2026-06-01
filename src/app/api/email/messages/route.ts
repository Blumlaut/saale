import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * GET /api/email/messages — List emails across user's accounts
 * Query params: accountId, folder, unread, starred, since, until, limit, offset, search, tag
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    account: { userId: session.user.id },
  };

  if (accountId) {
    where.accountId = accountId;
  }
  if (folder) {
    where.folder = folder;
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
        bodyHtml: true,
        bodyText: true,
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
        bodyHtml: string | null;
        bodyText: string | null;
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
        bodyHtml: m.bodyHtml,
        bodyText: m.bodyText,
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
