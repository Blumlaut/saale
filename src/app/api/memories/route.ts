import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/memories — List user's memories with optional filters
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

  const [memories, total] = await Promise.all([
    prisma.memory.findMany({
      where,
      orderBy: search ? [{ importance: "desc" }, { updatedAt: "desc" }] : { updatedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.memory.count({ where }),
  ]);

  // Full-text filter on client side if search provided
  let filtered = memories;
  if (search) {
    const q = search.toLowerCase();
    filtered = memories.filter(
      (m) =>
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }

  return NextResponse.json({
    memories: filtered.map((m) => ({
      id: m.id,
      collection: m.collection,
      title: m.title,
      content: m.content,
      tags: m.tags,
      importance: m.importance,
      source: m.source,
      accessCount: m.accessCount,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
    total,
    limit,
    offset,
  });
}

/**
 * POST /api/memories — Create a new memory
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { collection, title, content, tags, importance } = body;

  if (!collection || !title || !content) {
    return NextResponse.json(
      { error: "Missing required fields: collection, title, content" },
      { status: 400 },
    );
  }

  const memory = await prisma.memory.create({
    data: {
      userId: authResult.user.id,
      collection,
      title,
      content,
      tags: tags ?? [],
      importance: importance ?? 5,
    },
  });

  return NextResponse.json({
    memory: {
      id: memory.id,
      collection: memory.collection,
      title: memory.title,
      content: memory.content,
      tags: memory.tags,
      importance: memory.importance,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
    },
  });
}
