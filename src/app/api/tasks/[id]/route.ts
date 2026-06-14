import { NextRequest, NextResponse } from "next/server";
import { requireTaskOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/tasks/[id] — Get a single task
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireTaskOwner(id);
  if (!authResult.ok) return authResult.response;

  const t = authResult.task;

  return NextResponse.json({
    task: {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate?.toISOString() ?? null,
      tags: t.tags,
      order: t.order,
      source: t.source,
      sourceEmailId: t.sourceEmailId,
      completedAt: t.completedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    },
  });
}

/**
 * PATCH /api/tasks/[id] — Update a task
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireTaskOwner(id);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  const updateData: Record<string, unknown> = {};
  if (body.title !== undefined) updateData.title = body.title;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.priority !== undefined) updateData.priority = body.priority;
  if (body.dueDate !== undefined) updateData.dueDate = body.dueDate ? new Date(body.dueDate) : null;
  if (body.tags !== undefined) updateData.tags = body.tags;
  if (body.status !== undefined) updateData.status = body.status;
  if (body.order !== undefined) updateData.order = body.order;
  if (body.status === "completed") updateData.completedAt = new Date();
  if (body.status === "pending") updateData.completedAt = null;

  const task = await prisma.task.update({ where: { id }, data: updateData });

  return NextResponse.json({
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate?.toISOString() ?? null,
      tags: task.tags,
      order: task.order,
      source: task.source,
      sourceEmailId: task.sourceEmailId,
      completedAt: task.completedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
  });
}

/**
 * DELETE /api/tasks/[id] — Delete a task
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authResult = await requireTaskOwner(id);
  if (!authResult.ok) return authResult.response;

  await prisma.task.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
