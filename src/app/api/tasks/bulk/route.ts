import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * PATCH /api/tasks/bulk — Bulk update tasks (e.g. mark multiple as completed)
 * Body: { ids: string[], updates: { status?, priority?, dueDate?, tags? } }
 */
export async function PATCH(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { ids, updates } = body as {
    ids: string[];
    updates: Record<string, unknown>;
  };

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "Missing or invalid 'ids' array" }, { status: 400 });
  }

  const updateData: Record<string, unknown> = {};
  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.priority !== undefined) updateData.priority = updates.priority;
  if (updates.dueDate !== undefined && typeof updates.dueDate === "string")
    updateData.dueDate = updates.dueDate ? new Date(updates.dueDate) : null;
  if (updates.tags !== undefined) updateData.tags = updates.tags;
  if (updates.status === "completed") updateData.completedAt = new Date();
  if (updates.status === "pending") updateData.completedAt = null;

  const result = await prisma.task.updateMany({
    where: { id: { in: ids }, userId: authResult.user.id },
    data: updateData,
  });

  return NextResponse.json({ success: true, updated: result.count });
}
