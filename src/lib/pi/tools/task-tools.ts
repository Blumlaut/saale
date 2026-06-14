import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";

/**
 * Create task tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user.
 * Returns an array of tool definitions for direct spread into the agent session.
 */
export function createTaskTools(userId: string): ToolDefinition[] {
  /** Find a single task, scoped to user */
  async function findTaskByUser(taskId: string) {
    return prisma.task.findFirst({
      where: { id: taskId, userId },
    });
  }

  /** Serialize a task for tool response */
  function serializeTask(t: {
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
  }) {
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

  return [
    // ─── task_create ──────────────────────────────────────────────────────

    defineTool({
      name: "task_create",
      label: "Create Task",
      description:
        "Create a new task. Use when the user asks to remember something, sets a reminder, or mentions an action item.",
      parameters: Type.Object({
        title: Type.String({ description: "What needs to be done." }),
        description: Type.Optional(Type.String({ description: "Additional details." })),
        priority: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
            description: "Priority level. Default: medium.",
          }),
        ),
        dueDate: Type.Optional(
          Type.String({
            description: "ISO date string (e.g. '2025-07-15'). Optional.",
          }),
        ),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for grouping." })),
      }),
      execute: async (_toolCallId, params) => {
        // Search for potential duplicates before creating
        const existing = await prisma.task.findMany({
          where: {
            userId,
            status: "pending",
            title: { contains: params.title, mode: "insensitive" },
          },
          take: 5,
          select: { id: true, title: true },
        });

        const task = await prisma.task.create({
          data: {
            userId,
            title: params.title,
            description: params.description ?? null,
            priority: params.priority ?? "medium",
            dueDate: params.dueDate ? new Date(params.dueDate) : null,
            tags: params.tags ?? [],
            source: "chat",
          },
        });

        const response: Record<string, unknown> = {
          created: true,
          task: serializeTask(task),
        };

        if (existing.length > 0) {
          response.duplicates = existing.map((e) => ({
            id: e.id,
            title: e.title,
          }));
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
          details: { id: task.id },
        };
      },
    }),

    // ─── task_update ──────────────────────────────────────────────────────

    defineTool({
      name: "task_update",
      label: "Update Task",
      description:
        "Update an existing task — change title, priority, due date, or mark as completed.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID." }),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        priority: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
        ),
        dueDate: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("completed")])),
      }),
      execute: async (_toolCallId, params) => {
        const task = await findTaskByUser(params.taskId);
        if (!task) {
          throw new Error(`Task ${params.taskId} not found`);
        }

        const updateData: Record<string, unknown> = {};
        if (params.title !== undefined) updateData.title = params.title;
        if (params.description !== undefined) updateData.description = params.description;
        if (params.priority !== undefined) updateData.priority = params.priority;
        if (params.dueDate !== undefined)
          updateData.dueDate = params.dueDate ? new Date(params.dueDate) : null;
        if (params.tags !== undefined) updateData.tags = params.tags;
        if (params.status !== undefined) updateData.status = params.status;
        if (params.status === "completed") updateData.completedAt = new Date();
        if (params.status === "pending") {
          updateData.completedAt = null;
        }

        const updated = await prisma.task.update({
          where: { id: params.taskId },
          data: updateData,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  updated: true,
                  task: serializeTask(updated),
                },
                null,
                2,
              ),
            },
          ],
          details: { id: updated.id },
        };
      },
    }),

    // ─── task_list_pending ────────────────────────────────────────────────

    defineTool({
      name: "task_list_pending",
      label: "List Pending Tasks",
      description:
        "Get all pending tasks, sorted by due date then priority. Use to review what's open before creating new tasks or deciding what to work on next.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ description: "Maximum results. Default: 50." })),
      }),
      execute: async (_toolCallId, params) => {
        const limit = Math.min(params.limit ?? 50, 200);

        const tasks = await prisma.task.findMany({
          where: { userId, status: "pending" },
          orderBy: [
            { dueDate: { sort: "asc", nulls: "last" } },
            { priority: "desc" },
            { order: "asc" },
          ],
          take: limit,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: tasks.length,
                  tasks: tasks.map(serializeTask),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: tasks.length },
        };
      },
    }),

    // ─── task_search ──────────────────────────────────────────────────────

    defineTool({
      name: "task_search",
      label: "Search Tasks",
      description:
        "Search tasks by title, description, tags, or status. Use to find existing tasks before creating duplicates. Results include task IDs for reference in update/delete operations.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Search in titles and descriptions." })),
        status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("completed")])),
        priority: Type.Optional(
          Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
        ),
        dueBefore: Type.Optional(
          Type.String({
            description: "ISO date — tasks due before this date.",
          }),
        ),
        tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      }),
      execute: async (_toolCallId, params) => {
        const where: Record<string, unknown> = { userId };

        if (params.status) where.status = params.status;
        if (params.priority) where.priority = params.priority;
        if (params.tag) where.tags = { has: params.tag };
        if (params.dueBefore) {
          where.dueDate = { not: null, lt: new Date(params.dueBefore) };
        }

        const tasks = await prisma.task.findMany({
          where,
          orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
          take: 100,
        });

        // Full-text filter on query
        let filtered = tasks;
        if (params.query) {
          const q = params.query.toLowerCase();
          filtered = tasks.filter(
            (t) =>
              t.title.toLowerCase().includes(q) ||
              (t.description ?? "").toLowerCase().includes(q) ||
              t.tags.some((tag) => tag.toLowerCase().includes(q)),
          );
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query: params.query ?? null,
                  count: filtered.length,
                  tasks: filtered.map(serializeTask),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: filtered.length },
        };
      },
    }),

    // ─── task_delete ──────────────────────────────────────────────────────

    defineTool({
      name: "task_delete",
      label: "Delete Task",
      description: "Permanently delete a task. Use sparingly — prefer marking as completed.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID." }),
      }),
      execute: async (_toolCallId, params) => {
        const task = await findTaskByUser(params.taskId);
        if (!task) {
          throw new Error(`Task ${params.taskId} not found`);
        }

        await prisma.task.delete({ where: { id: params.taskId } });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  deleted: true,
                  id: params.taskId,
                  title: task.title,
                },
                null,
                2,
              ),
            },
          ],
          details: { id: params.taskId },
        };
      },
    }),
  ];
}
