import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * GET /api/search — Unified fuzzy search across chat and email.
 * Uses pg_trgm similarity for fuzzy matching and relevance ranking.
 *
 * Query params: q (required), type (optional: "all" | "chat" | "email"), limit
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const type = url.searchParams.get("type") ?? "all";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "15", 10), 50);

  if (!query || !query.trim()) {
    return NextResponse.json({ error: "Query parameter 'q' is required" }, { status: 400 });
  }

  const results: Array<{
    type: "chat" | "email";
    id: string;
    title: string;
    snippet: string;
    date: string;
    score: number;
    metadata?: Record<string, unknown>;
  }> = [];

  const trimmedQuery = query.trim();

  // Search chat sessions — fuzzy match on title, rank by similarity
  if (type === "all" || type === "chat") {
    const chatRows = await prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        updatedAt: Date;
        messageCount: number;
        similarity: number;
      }>
    >(
      Prisma.sql`
        SELECT
          "ChatSession".id,
          "ChatSession".title,
          "ChatSession"."updatedAt",
          "ChatSession"."messageCount",
          similarity("ChatSession".title, ${trimmedQuery}) AS similarity
        FROM "ChatSession"
        WHERE "ChatSession"."userId" = ${authResult.user.id}
          AND "ChatSession".title % ${trimmedQuery}
        ORDER BY similarity DESC
        LIMIT ${limit}
      `,
    );

    for (const row of chatRows) {
      results.push({
        type: "chat",
        id: row.id,
        title: row.title,
        snippet: row.title,
        date: row.updatedAt.toISOString(),
        score: Number(row.similarity),
        metadata: {
          messageCount: row.messageCount,
        },
      });
    }
  }

  // Search emails — fuzzy match across subject/from/body, rank by weighted similarity
  if (type === "all" || type === "email") {
    const emailRows = await prisma.$queryRaw<
      Array<{
        id: string;
        subject: string;
        fromName: string | null;
        fromEmail: string;
        bodyPreview: string | null;
        date: Date;
        folder: string;
        isRead: boolean;
        score: number;
      }>
    >(
      Prisma.sql`
        SELECT
          "EmailMessage".id,
          "EmailMessage".subject,
          "EmailMessage"."fromName",
          "EmailMessage"."fromEmail",
          "EmailMessage"."bodyPreview",
          "EmailMessage".date,
          "EmailMessage".folder,
          "EmailMessage"."isRead",
          (
            similarity("EmailMessage".subject, ${trimmedQuery}) * 3.0
            + similarity("EmailMessage"."fromName", ${trimmedQuery}) * 1.5
            + similarity("EmailMessage"."fromEmail", ${trimmedQuery}) * 1.5
            + similarity(COALESCE("EmailMessage"."bodyPreview", ''), ${trimmedQuery}) * 1.0
          ) AS score
        FROM "EmailMessage"
        JOIN "EmailAccount" ON "EmailMessage"."accountId" = "EmailAccount".id
        WHERE "EmailAccount"."userId" = ${authResult.user.id}
          AND (
            "EmailMessage".subject % ${trimmedQuery}
            OR "EmailMessage"."fromName" % ${trimmedQuery}
            OR "EmailMessage"."fromEmail" % ${trimmedQuery}
            OR COALESCE("EmailMessage"."bodyPreview", '') % ${trimmedQuery}
          )
        ORDER BY score DESC
        LIMIT ${limit}
      `,
    );

    for (const row of emailRows) {
      const preview = row.bodyPreview ?? "";
      const snippet =
        `${row.fromName || row.fromEmail}: ` +
        preview.slice(0, 150) +
        (preview.length >= 150 ? "..." : "");

      results.push({
        type: "email",
        id: row.id,
        title: row.subject || "(no subject)",
        snippet,
        date: row.date.toISOString(),
        score: Number(row.score),
        metadata: {
          from: row.fromName || row.fromEmail,
          folder: row.folder,
          read: row.isRead,
        },
      });
    }
  }

  // Sort by score descending (best matches first)
  results.sort((a, b) => b.score - a.score);

  return NextResponse.json({
    query: trimmedQuery,
    results: results.slice(0, limit),
    total: results.length,
  });
}
