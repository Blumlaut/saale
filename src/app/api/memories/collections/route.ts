import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { Prisma } from "../../../../../prisma/generated/prisma";

/**
 * GET /api/memories/collections — List collections with counts and top tags
 */
export async function GET() {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const collections = await prisma.memory.groupBy({
    by: ["collection"],
    where: { userId: authResult.user.id },
    _count: { id: true },
    _avg: { importance: true },
    orderBy: { _count: { id: "desc" } },
  });

  const details = await Promise.all(
    collections.map(async (c) => {
      const tagResults = await prisma.$queryRaw<Array<{ tag: string; count: number }>>(
        Prisma.sql`
          SELECT UNNEST(tags) AS tag, COUNT(*)::int AS count
          FROM "Memory"
          WHERE "userId" = ${authResult.user.id} AND collection = ${c.collection}
          GROUP BY tag
          ORDER BY count DESC
          LIMIT 8
        `,
      );

      return {
        name: c.collection,
        count: c._count.id,
        avgImportance: Math.round((c._avg.importance ?? 0) * 10) / 10,
        topTags: tagResults.map((t) => t.tag),
      };
    }),
  );

  const total = await prisma.memory.count({ where: { userId: authResult.user.id } });

  return NextResponse.json({ collections: details, total });
}

/**
 * DELETE /api/memories/collections — Delete all memories in a collection
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
