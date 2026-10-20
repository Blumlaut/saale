import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import {
  taskToResponse,
  buildTaskUpdateData,
  findDuplicateTasks,
} from "@/lib/tasks/task-api-helpers";

/** A task as every task tool reports it. the shared wire shape from taskToResponse. */
const taskSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  priority: Type.String(),
  dueDate: Type.Union([Type.String(), Type.Null()]),
  tags: Type.Array(Type.String()),
  order: Type.Integer(),
  source: Type.String(),
  sourceEmailId: Type.Union([Type.String(), Type.Null()]),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/** A created task, plus any pending tasks whose title it resembles. */
const taskCreateSchema = Type.Object({
  created: Type.Boolean(),
  task: taskSchema,
  // Present only when a similar pending task already exists.
  duplicates: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String() }))),
});

const taskUpdateSchema = Type.Object({ updated: Type.Boolean(), task: taskSchema });

const taskListSchema = Type.Object({
  count: Type.Integer(),
  tasks: Type.Array(taskSchema),
});

const taskSearchSchema = Type.Object({
  // Null on the structured-filter path, which is not a text search.
  query: Type.Union([Type.String(), Type.Null()]),
  count: Type.Integer(),
  tasks: Type.Array(taskSchema),
});

const taskDeleteSchema = Type.Object({
  deleted: Type.Boolean(),
  id: Type.String(),
  title: Type.String(),
});

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

  return [
    // ─── task_create ──────────────────────────────────────────────────────

    defineStructuredTool({
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
      outputSchema: taskCreateSchema,
      execute: async (_toolCallId, params) => {
        // Search for potential duplicates before creating
        const existing = await findDuplicateTasks(params.title, userId);

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

        return {
          value: {
            created: true,
            task: taskToResponse(task),
            // Omitted entirely, not set to undefined: the schema makes the key optional.
            ...(existing.length > 0
              ? {
                  duplicates: existing.map((e) => ({
                    id: e.id,
                    title: e.title,
                  })),
                }
              : {}),
          },
          details: { id: task.id },
        };
      },
    }),

    // ─── task_update ──────────────────────────────────────────────────────

    defineStructuredTool({
      name: "task_update",
      label: "Update Task",
      description:
        "Update an existing task. change title, priority, due date, or mark as completed.",
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
      outputSchema: taskUpdateSchema,
      execute: async (_toolCallId, params) => {
        const task = await findTaskByUser(params.taskId);
        if (!task) {
          throw new Error(`Task ${params.taskId} not found`);
        }

        const updateData = buildTaskUpdateData(params);

        const updated = await prisma.task.update({
          where: { id: params.taskId },
          data: updateData,
        });

        return {
          value: {
            updated: true,
            task: taskToResponse(updated),
          },
          details: { id: updated.id },
        };
      },
    }),

    // ─── task_list_pending ────────────────────────────────────────────────

    defineStructuredTool({
      name: "task_list_pending",
      label: "List Pending Tasks",
      description:
        "Get all pending tasks, sorted by due date then priority. Use to review what's open before creating new tasks or deciding what to work on next.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ description: "Maximum results. Default: 50." })),
      }),
      outputSchema: taskListSchema,
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
          value: {
            count: tasks.length,
            tasks: tasks.map(taskToResponse),
          },
          details: { count: tasks.length },
        };
      },
    }),

    // ─── task_search ──────────────────────────────────────────────────────

    defineStructuredTool({
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
            description: "ISO date. tasks due before this date.",
          }),
        ),
        tag: Type.Optional(Type.String({ description: "Filter by tag." })),
      }),
      outputSchema: taskSearchSchema,
      execute: async (_toolCallId, params) => {
        const trimmedQuery = params.query?.trim();
        const hasQuery = trimmedQuery?.length ?? 0 > 0;

        if (hasQuery && trimmedQuery) {
          // Use PostgreSQL full-text search (consistent with memory_search and chat_search)

          const results = await prisma.$queryRaw<
            Array<{
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
              rank: number;
            }>
          >(
            Prisma.sql`
              SELECT id, title, description, status, priority, "dueDate", tags, "order",
                     source, "sourceEmailId", "completedAt", "createdAt", "updatedAt",
                     ts_rank(to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '')), plainto_tsquery('english', ${trimmedQuery})) AS rank
              FROM "Task"
              WHERE "userId" = ${userId}
                ${params.status ? Prisma.sql`AND status = ${params.status}` : Prisma.empty}
                ${params.priority ? Prisma.sql`AND priority = ${params.priority}` : Prisma.empty}
                ${params.tag ? Prisma.sql`AND tags && ARRAY[${params.tag}]::text[]` : Prisma.empty}
                ${params.dueBefore ? Prisma.sql`AND "dueDate" IS NOT NULL AND "dueDate" < ${new Date(params.dueBefore)}` : Prisma.empty}
                AND to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, '')) @@ plainto_tsquery('english', ${trimmedQuery})
              ORDER BY rank DESC
              LIMIT 100
            `,
          );

          return {
            value: {
              query: trimmedQuery,
              count: results.length,
              tasks: results.map(taskToResponse),
            },
            details: { count: results.length },
          };
        }

        // No query. use Prisma ORM for structured filters
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

        return {
          value: {
            query: null,
            count: tasks.length,
            tasks: tasks.map(taskToResponse),
          },
          details: { count: tasks.length },
        };
      },
    }),

    // ─── task_delete ──────────────────────────────────────────────────────

    defineStructuredTool({
      name: "task_delete",
      label: "Delete Task",
      description: "Permanently delete a task. Use sparingly. prefer marking as completed.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID." }),
      }),
      outputSchema: taskDeleteSchema,
      execute: async (_toolCallId, params) => {
        const task = await findTaskByUser(params.taskId);
        if (!task) {
          throw new Error(`Task ${params.taskId} not found`);
        }

        await prisma.task.delete({ where: { id: params.taskId } });

        return {
          value: {
            deleted: true,
            id: params.taskId,
            title: task.title,
          },
          details: { id: params.taskId },
        };
      },
    }),
  ];
}
