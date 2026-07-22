import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/infra/machines/[id]/notes — List notes for a machine
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;
  const searchParams = request.nextUrl.searchParams;
  const category = searchParams.get("category");

  const machine = await prisma.infraMachine.findFirst({
    where: { id, userId: authResult.user.id },
    select: { id: true },
  });

  if (!machine) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  const where: Record<string, unknown> = { machineId: id };
  if (category) {
    where.category = category;
  }

  const notes = await prisma.infraNote.findMany({
    where,
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({
    notes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      category: n.category,
      content: n.content,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    })),
  });
}

/**
 * POST /api/infra/machines/[id]/notes — Create a note
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { id } = await params;

  const machine = await prisma.infraMachine.findFirst({
    where: { id, userId: authResult.user.id },
    select: { id: true },
  });

  if (!machine) {
    return NextResponse.json({ error: "Machine not found" }, { status: 404 });
  }

  const body = await request.json();
  const { title, content, category } = body;

  if (!title || !content) {
    return NextResponse.json({ error: "Missing required fields: title, content" }, { status: 400 });
  }

  const note = await prisma.infraNote.create({
    data: {
      machineId: id,
      title,
      content,
      category: category ?? "general",
    },
  });

  return NextResponse.json({
    note: {
      id: note.id,
      title: note.title,
      category: note.category,
      content: note.content,
      createdAt: note.createdAt.toISOString(),
    },
  });
}
