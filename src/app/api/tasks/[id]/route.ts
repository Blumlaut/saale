import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireTaskOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { taskToResponse, buildTaskUpdateData } from "@/lib/tasks/task-api-helpers";

/**
 * GET /api/tasks/[id]. Get a single task
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireTaskOwner(id);
  if (!authResult.ok) return authResult.response;

  return NextResponse.json({ task: taskToResponse(authResult.task) });
}

/**
 * PATCH /api/tasks/[id]. Update a task
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const authResult = await requireTaskOwner(id);
  if (!authResult.ok) return authResult.response;

  const body = await request.json();

  const updateData = buildTaskUpdateData(body);

  const task = await prisma.task.update({ where: { id }, data: updateData });

  return NextResponse.json({ task: taskToResponse(task) });
}

/**
 * DELETE /api/tasks/[id]. Delete a task
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
