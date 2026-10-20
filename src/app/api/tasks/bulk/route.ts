import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildTaskUpdateData } from "@/lib/tasks/task-api-helpers";

/**
 * PATCH /api/tasks/bulk. Bulk update tasks (e.g. mark multiple as completed)
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

  const updateData = buildTaskUpdateData(updates);

  const result = await prisma.task.updateMany({
    where: { id: { in: ids }, userId: authResult.user.id },
    data: updateData,
  });

  return NextResponse.json({ success: true, updated: result.count });
}
