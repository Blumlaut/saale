import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { searchChatMessages, searchChatSessions, searchUserMail } from "@/lib/search/sources";

/**
 * GET /api/search. Fuzzy search for the ⌘K palette, across chats and email.
 *
 * Chats match by title or by anything said in them. Email matches subject,
 * sender, and body. Every word of the query has to match, and results come back
 * best first, so a long query narrows instead of flooding.
 *
 * Query params: q (required), type (optional: "all" | "chat" | "email"), limit
 */

interface PaletteResult {
  type: "chat" | "email";
  id: string;
  title: string;
  snippet: string;
  date: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/** A body excerpt around the first word that matched, so the snippet shows why. */
function snippetAround(text: string, query: string, length: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= length) return flat;

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = flat.toLowerCase();
  const at = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);

  const start = at <= 0 ? 0 : Math.max(0, at - Math.floor(length / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + length)}…`;
}

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

  const userId = authResult.user.id;
  const trimmedQuery = query.trim();
  const results: PaletteResult[] = [];

  if (type === "all" || type === "chat") {
    const [sessions, messages] = await Promise.all([
      searchChatSessions(userId, trimmedQuery, { limit }),
      searchChatMessages(userId, trimmedQuery, { limit }),
    ]);

    // One row per chat: the title match and any message hit collapse together.
    const byId = new Map<string, PaletteResult>();

    for (const session of sessions) {
      byId.set(session.id, {
        type: "chat",
        id: session.id,
        title: session.title,
        snippet: session.title,
        date: session.lastActivityAt.toISOString(),
        score: session.score,
        metadata: { messageCount: session.messageCount },
      });
    }

    for (const message of messages) {
      const existing = byId.get(message.sessionId);
      if (existing && existing.score >= message.score) continue;

      byId.set(message.sessionId, {
        type: "chat",
        id: message.sessionId,
        title: message.sessionTitle,
        snippet: snippetAround(message.content, trimmedQuery, 150),
        date: message.createdAt.toISOString(),
        score: message.score,
        metadata: { messageCount: existing?.metadata?.messageCount },
      });
    }

    results.push(...byId.values());
  }

  if (type === "all" || type === "email") {
    const emails = await searchUserMail(userId, trimmedQuery, { limit });

    for (const email of emails) {
      const preview = email.bodyPreview ?? "";
      results.push({
        type: "email",
        id: email.id,
        title: email.subject || "(no subject)",
        snippet: `${email.fromName || email.fromEmail}: ${snippetAround(preview, trimmedQuery, 150)}`,
        date: email.date.toISOString(),
        score: email.score,
        metadata: {
          from: email.fromName || email.fromEmail,
          folder: email.folder,
          read: email.isRead,
          accountId: email.accountId,
        },
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  return NextResponse.json({
    query: trimmedQuery,
    results: results.slice(0, limit),
    total: results.length,
  });
}
