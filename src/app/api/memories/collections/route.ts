import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";

/**
 * GET /api/memories/collections. List collections with counts and top tags
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const collections = await prisma.memory.groupBy({
    by: ["collection"],
    where: { userId: authResult.user.id },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
  });

  // one grouped query for top tags across all collections instead of N queries
  const tagRows = await prisma.$queryRaw<Array<{ collection: string; tag: string; count: number }>>(
    Prisma.sql`
      SELECT collection, UNNEST(tags) AS tag, COUNT(*)::int AS count
      FROM "Memory"
      WHERE "userId" = ${authResult.user.id}
      GROUP BY collection, tag
      ORDER BY collection, count DESC
    `,
  );

  const topTagsByCollection = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = topTagsByCollection.get(row.collection) ?? [];
    if (list.length < 8) list.push(row.tag);
    topTagsByCollection.set(row.collection, list);
  }

  const details = collections.map((c) => ({
    name: c.collection,
    count: c._count.id,
    topTags: topTagsByCollection.get(c.collection) ?? [],
  }));

  const total = await prisma.memory.count({ where: { userId: authResult.user.id } });

  return NextResponse.json({ collections: details, total });
}

/**
 * DELETE /api/memories/collections. Delete all memories in a collection
 */
export async function DELETE(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const name = searchParams.get("name");

  if (!name) {
    return NextResponse.json({ error: "Missing collection name" }, { status: 400 });
  }

  const result = await prisma.memory.deleteMany({
    where: { userId: authResult.user.id, collection: name },
  });

  return NextResponse.json({ deleted: result.count });
}
