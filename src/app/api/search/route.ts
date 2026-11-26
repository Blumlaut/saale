import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { DEFAULT_PALETTE_LIMIT, searchPalette } from "@/lib/search/palette";
import { paletteKindsFrom } from "@/lib/search/palette-result";

/**
 * GET /api/search. The ⌘K palette, across everything the agent can search:
 * chats, email, contacts, tasks, calendar events and memories.
 *
 * Query params: q (required), type (optional: "all" or a comma-separated list of
 * kinds), limit
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ error: "Query parameter 'q' is required" }, { status: 400 });
  }

  const results = await searchPalette(authResult.user.id, query, {
    kinds: paletteKindsFrom(url.searchParams.get("type")),
    limit: Number(url.searchParams.get("limit") ?? DEFAULT_PALETTE_LIMIT),
  });

  return NextResponse.json({ query, results, total: results.length });
}
