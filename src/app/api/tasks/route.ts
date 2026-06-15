import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/tasks — List tasks with optional filters
 * Query params: status, priority, dueBefore, dueAfter, tag, source, sort, limit, offset
 */
export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? undefined;
  const priority = searchParams.get("priority") ?? undefined;
  const dueBefore = searchParams.get("dueBefore") ?? undefined;
  const dueAfter = searchParams.get("dueAfter") ?? undefined;
  const tag = searchParams.get("tag") ?? undefined;
  const source = searchParams.get("source") ?? undefined;
  const sort = searchParams.get("sort") ?? "dueDate";
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "100"), 200);
  const offset = parseInt(searchParams.get("offset") ?? "0");

  const where: Record<string, unknown> = { userId: authResult.user.id };
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (tag) where.tags = { has: tag };
  if (source) where.source = source;

  if (dueBefore || dueAfter) {
    const dueDateFilter: Record<string, unknown> = {};
    if (dueBefore) dueDateFilter.lt = new Date(dueBefore);
    if (dueAfter) dueDateFilter.gt = new Date(dueAfter);
    where.dueDate = dueDateFilter;
  }

  const orderBy: Record<string, unknown>[] = [];
  if (sort === "dueDate") {
    orderBy.push({ dueDate: { sort: "asc", nulls: "last" as const } });
  } else if (sort === "priority") {
    orderBy.push({ priority: "desc" as const });
  } else if (sort === "createdAt") {
    orderBy.push({ createdAt: "desc" as const });
  }
  orderBy.push({ order: "asc" as const });

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({ where, orderBy, take: limit, skip: offset }),
    prisma.task.count({ where }),
  ]);

  return NextResponse.json({
    tasks: tasks.map((t) => ({
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
    })),
    total,
    limit,
    offset,
  });
}

/**
 * POST /api/tasks — Create a new task
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { title, description, priority, dueDate, tags, source } = body;

  if (!title) {
    return NextResponse.json({ error: "Missing required field: title" }, { status: 400 });
  }

  const task = await prisma.task.create({
    data: {
      userId: authResult.user.id,
      title,
      description: description ?? null,
      priority: priority ?? "medium",
      dueDate: dueDate ? new Date(dueDate) : null,
      tags: tags ?? [],
      source: source ?? "manual",
    },
  });

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
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    },
  });
}
