import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";

/**
 * GET /api/search — Unified search across chat and email
 * Query params: q (required), type (optional: "all" | "chat" | "email"), limit
 */
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const type = url.searchParams.get("type") ?? "all";
  const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);

  if (!query) {
    return NextResponse.json({ error: "Query parameter 'q' is required" }, { status: 400 });
  }

  const results: Array<{
    type: "chat" | "email";
    id: string;
    title: string;
    snippet: string;
    date: string;
    metadata?: Record<string, unknown>;
  }> = [];

  // Search chat sessions
  if (type === "all" || type === "chat") {
    const chatSessions = await prisma.chatSession.findMany({
      where: {
        userId: session.user.id,
        OR: [{ title: { contains: query, mode: "insensitive" } }],
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          where: {
            OR: [{ content: { contains: query, mode: "insensitive" } }],
          },
        },
      },
    });

    for (const cs of chatSessions) {
      const snippet = cs.messages[0]?.content?.slice(0, 150) ?? cs.title;
      results.push({
        type: "chat",
        id: cs.id,
        title: cs.title,
        snippet: snippet + (snippet.length >= 150 ? "..." : ""),
        date: cs.updatedAt.toISOString(),
        metadata: {
          messageCount: cs.messageCount,
        },
      });
    }
  }

  // Search emails
  if (type === "all" || type === "email") {
    const emails = await prisma.emailMessage.findMany({
      where: {
        account: { userId: session.user.id },
        OR: [
          { subject: { contains: query, mode: "insensitive" } },
          { fromEmail: { contains: query, mode: "insensitive" } },
          { fromName: { contains: query, mode: "insensitive" } },
          { bodyPreview: { contains: query, mode: "insensitive" } },
          { bodyText: { contains: query, mode: "insensitive" } },
        ],
      },
      orderBy: { date: "desc" },
      take: limit,
      select: {
        id: true,
        subject: true,
        fromName: true,
        fromEmail: true,
        bodyPreview: true,
        date: true,
        folder: true,
        isRead: true,
      },
    });

    for (const email of emails) {
      results.push({
        type: "email",
        id: email.id,
        title: email.subject || "(no subject)",
        snippet:
          `${email.fromName || email.fromEmail}: ` +
          email.bodyPreview.slice(0, 150) +
          (email.bodyPreview.length >= 150 ? "..." : ""),
        date: email.date.toISOString(),
        metadata: {
          from: email.fromName || email.fromEmail,
          folder: email.folder,
          read: email.isRead,
        },
      });
    }
  }

  // Sort by date descending
  results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return NextResponse.json({
    query,
    results: results.slice(0, limit * 2),
    total: results.length,
  });
}
