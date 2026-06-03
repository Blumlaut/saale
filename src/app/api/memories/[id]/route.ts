import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/memories/[id] — Get a single memory
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;
  const memory = await prisma.memory.findFirst({
    where: { id, userId: authResult.user.id },
  });

  if (!memory) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

  return NextResponse.json({
    memory: {
      id: memory.id,
      collection: memory.collection,
      title: memory.title,
      content: memory.content,
      tags: memory.tags,
      importance: memory.importance,
      source: memory.source,
      accessCount: memory.accessCount,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/memories/[id] — Update a memory
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;
  const body = await request.json();

  const existing = await prisma.memory.findFirst({
    where: { id, userId: authResult.user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

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
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;
  const existing = await prisma.memory.findFirst({
    where: { id, userId: authResult.user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

  await prisma.memory.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
