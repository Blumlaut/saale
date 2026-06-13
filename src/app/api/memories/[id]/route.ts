import { NextRequest, NextResponse } from "next/server";
import { requireMemoryOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/memories/[id] — Get a single memory
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireMemoryOwner(id);
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({
    memory: {
      id: authResult.memory.id,
      collection: authResult.memory.collection,
      title: authResult.memory.title,
      content: authResult.memory.content,
      tags: authResult.memory.tags,
      importance: authResult.memory.importance,
      source: authResult.memory.source,
      accessCount: authResult.memory.accessCount,
      createdAt: authResult.memory.createdAt.toISOString(),
      updatedAt: authResult.memory.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/memories/[id] — Update a memory
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireMemoryOwner(id);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  const memory = await prisma.memory.update({
    where: { id },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.content !== undefined && { content: body.content }),
      ...(body.collection !== undefined && { collection: body.collection }),
      ...(body.tags !== undefined && { tags: body.tags }),
      ...(body.importance !== undefined && {
        importance: Math.max(1, Math.min(10, body.importance)),
      }),
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
      updatedAt: memory.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/memories/[id] — Delete a memory
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireMemoryOwner(id);
  if (!authResult.ok) return authResult.response;

  await prisma.memory.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
