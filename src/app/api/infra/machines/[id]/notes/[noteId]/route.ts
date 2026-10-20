import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/infra/machines/[id]/notes/[noteId]. Update a note
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id, noteId } = await params;

  const note = await prisma.infraNote.findFirst({
    where: { id: noteId, machineId: id },
    include: { machine: { select: { userId: true } } },
  });

  if (!note) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  if (note.machine.userId !== authResult.user.id) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  const body = await request.json();
  const data: Record<string, unknown> = {};

  if (body.title !== undefined) data.title = body.title;
  if (body.content !== undefined) data.content = body.content;
  if (body.category !== undefined) data.category = body.category;

  const updated = await prisma.infraNote.update({
    where: { id: noteId },
    data,
  });

  return NextResponse.json({
    note: {
      id: updated.id,
      title: updated.title,
      category: updated.category,
      content: updated.content,
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/infra/machines/[id]/notes/[noteId]. Delete a note
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id, noteId } = await params;

  const note = await prisma.infraNote.findFirst({
    where: { id: noteId, machineId: id },
    include: { machine: { select: { userId: true } } },
  });

  if (!note) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  if (note.machine.userId !== authResult.user.id) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }

  await prisma.infraNote.delete({ where: { id: noteId } });

  return NextResponse.json({ deleted: true, id: noteId });
}
