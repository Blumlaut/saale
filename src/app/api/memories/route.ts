import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createMemory, serializeMemory } from "@/lib/memory/store";
import { countMemories, searchMemories } from "@/lib/search/sources";

/**
 * GET /api/memories. List user's memories with optional filters
 * Query params: collection, tag, search, limit, offset
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const collection = searchParams.get("collection") ?? undefined;
  const tag = searchParams.get("tag") ?? undefined;
  const search = searchParams.get("search") ?? undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100"), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const where: Record<string, unknown> = { userId: authResult.user.id };
  if (collection) where.collection = collection;
  if (tag) where.tags = { has: tag };

  const trimmedSearch = search?.trim();

  if (trimmedSearch) {
    const filters = { collection, tags: tag ? [tag] : undefined };
    const [memories, total] = await Promise.all([
      searchMemories(authResult.user.id, trimmedSearch, { ...filters, limit, offset }),
      countMemories(authResult.user.id, trimmedSearch, filters),
    ]);

    return NextResponse.json({
      memories: memories.map(serializeMemory),
      total,
      limit,
      offset,
    });
  }

  const [memories, total] = await Promise.all([
    prisma.memory.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.memory.count({ where }),
  ]);

  return NextResponse.json({
    memories: memories.map(serializeMemory),
    total,
    limit,
    offset,
  });
}

/**
 * POST /api/memories. Create a new memory
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { collection, title, content, tags } = body;

  if (!collection || !title || !content) {
    return NextResponse.json(
      { error: "Missing required fields: collection, title, content" },
      { status: 400 },
    );
  }

  const memory = await createMemory(authResult.user.id, {
    collection,
    title,
    content,
    tags,
  });

  return NextResponse.json({ memory: serializeMemory(memory) });
}
