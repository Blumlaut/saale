import { prisma } from "@/lib/db";

/**
 * Shared shape for serialized task responses.
 * Used by API routes and AI tool responses.
 */
export interface TaskResponse {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  tags: string[];
  order: number;
  source: string;
  sourceEmailId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Minimal shape accepted by taskToResponse. works with both
 * full Prisma Task records and raw query results (which may omit
 * userId, notifiedAt, etc.).
 */
interface TaskLike {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: Date | null;
  tags: string[];
  order: number;
  source: string;
  sourceEmailId: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Serialize a Prisma Task record (with Date fields) to a flat JSON-ready response.
 * Shared by API routes and AI tool responses.
 */
export function taskToResponse(t: TaskLike): TaskResponse {
  return {
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
  };
}

/**
 * Build update data for a task, handling the status → completedAt transition.
 *
 * When status changes to "completed", sets completedAt to now.
 * When status changes to "pending", clears completedAt.
 *
 * @param updates Partial update fields (title, description, priority, etc.)
 * @returns Prisma-compatible update data object
 */
export function buildTaskUpdateData(updates: {
  title?: string;
  description?: string | null;
  priority?: string;
  dueDate?: string | null;
  tags?: string[];
  status?: string;
  order?: number;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  if (updates.title !== undefined) data.title = updates.title;
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.priority !== undefined) data.priority = updates.priority;
  if (updates.dueDate !== undefined)
    data.dueDate = updates.dueDate ? new Date(updates.dueDate) : null;
  if (updates.tags !== undefined) data.tags = updates.tags;
  if (updates.status !== undefined) data.status = updates.status;
  if (updates.order !== undefined) data.order = updates.order;

  // Handle completedAt transition
  if (updates.status === "completed") data.completedAt = new Date();
  if (updates.status === "pending") data.completedAt = null;

  return data;
}

/**
 * Find potential duplicate pending tasks for a given title.
 * Uses DB-level case-insensitive substring matching scoped to the user.
 *
 * Shared by task-extraction.ts (email extraction) and task-tools.ts (AI tool).
 *
 * @param title Task title to check against
 * @param userId User to scope the search to
 * @returns Array of matching pending tasks (id + title)
 */
export async function findDuplicateTasks(title: string, userId: string) {
  return prisma.task.findMany({
    where: {
      userId,
      status: "pending",
      title: { contains: title, mode: "insensitive" },
    },
    take: 5,
    select: { id: true, title: true },
  });
}
