import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { getQueue, addJobRun } from "@/lib/queue";
import { jobTypeSchemas } from "@/lib/queue/job-schemas";

/**
 * Create task (job) tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's tasks.
 * Returns an array of tool definitions for direct spread into the agent session.
 *
 * Tool names use "task_*" to match the frontend "Tasks" sidebar label.
 */
export function createJobTools(userId: string): ToolDefinition[] {
  return [
    // ─── task_list ──────────────────────────────────────────────────────────

    defineTool({
      name: "task_list",
      label: "List Tasks",
      description: "List all configured tasks with their current status, schedule, and run count.",
      parameters: Type.Object({
        enabled: Type.Optional(
          Type.Boolean({
            description: "Filter by enabled/disabled status.",
          }),
        ),
        type: Type.Optional(
          Type.String({
            description:
              "Filter by task type (e.g. 'summarization', 'classification', 'spam_filtering').",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const where: Record<string, unknown> = { userId };
        if (params.enabled !== undefined) {
          where.enabled = params.enabled;
        }
        if (params.type) {
          where.type = params.type;
        }

        const jobs = await prisma.queueTask.findMany({
          where,
          orderBy: { createdAt: "asc" },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: jobs.length,
                  tasks: jobs.map(
                    (j: {
                      id: string;
                      type: string;
                      enabled: boolean;
                      modelId: string | null;
                      config: string;
                      lastRunAt: Date | null;
                      runCount: number;
                      createdAt: Date;
                    }) => ({
                      id: j.id,
                      type: j.type,
                      enabled: j.enabled,
                      modelId: j.modelId,
                      config: JSON.parse(j.config),
                      lastRunAt: j.lastRunAt?.toISOString(),
                      runCount: j.runCount,
                      createdAt: j.createdAt.toISOString(),
                    }),
                  ),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: jobs.length },
        };
      },
    }),

    // ─── task_enable ────────────────────────────────────────────────────────

    defineTool({
      name: "task_enable",
      label: "Enable/Disable Task",
      description: "Enable or disable a task by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Task ID.",
        }),
        enabled: Type.Boolean({
          description: "Whether to enable (true) or disable (false) the task.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
        });

        if (!job) {
          throw new Error(`Task ${params.id} not found`);
        }

        await prisma.queueTask.update({
          where: { id: params.id },
          data: { enabled: params.enabled },
        });

        // Update BullMQ schedule
        const queue = getQueue();
        if (params.enabled) {
          const config = JSON.parse(job.config);
          if (config.cronExpression) {
            await queue.add(
              "execute",
              { ...config, taskId: params.id, type: job.type, modelId: job.modelId },
              {
                jobId: `scheduled-${params.id}`,
                repeat: { pattern: config.cronExpression, tz: "UTC" },
              },
            );
          }
        } else {
          await queue.remove(`scheduled-${params.id}`).catch((err) => {
            console.error("Failed to remove scheduled job:", err);
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: params.id,
                  enabled: params.enabled,
                },
                null,
                2,
              ),
            },
          ],
          details: { id: params.id, enabled: params.enabled },
        };
      },
    }),

    // ─── task_run ───────────────────────────────────────────────────────────

    defineTool({
      name: "task_run",
      label: "Run Task Now",
      description: "Trigger an immediate manual run of a task by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Task ID to run.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
        });

        if (!job) {
          throw new Error(`Task ${params.id} not found`);
        }

        const queue = getQueue();
        const config = JSON.parse(job.config);

        const jobRun = await addJobRun(params.id, "pending", JSON.stringify(config));

        await queue.add(
          "execute",
          { ...config, taskId: params.id, runId: jobRun.id, type: job.type, modelId: job.modelId },
          {
            jobId: `manual-${params.id}-${Date.now()}`,
            removeOnComplete: false,
            removeOnFail: 100,
          },
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  queued: true,
                  taskId: params.id,
                  runId: jobRun.id,
                },
                null,
                2,
              ),
            },
          ],
          details: { queued: true, runId: jobRun.id },
        };
      },
    }),

    // ─── task_logs ──────────────────────────────────────────────────────────

    defineTool({
      name: "task_logs",
      label: "Task Logs",
      description: "View recent run history for a task, including status, output, and errors.",
      parameters: Type.Object({
        id: Type.String({
          description: "Task ID.",
        }),
        limit: Type.Optional(
          Type.Integer({
            description: "Number of recent runs to return. Default: 10.",
            default: 10,
          }),
        ),
        status: Type.Optional(
          Type.String({
            description: "Filter by run status: 'pending', 'running', 'completed', 'error'.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        // Verify the task belongs to this user
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
          select: { id: true },
        });

        if (!job) {
          throw new Error(`Task ${params.id} not found`);
        }

        const where: Record<string, unknown> = { taskId: params.id };
        if (params.status) {
          where.status = params.status;
        }

        const runs = await prisma.taskRun.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: params.limit ?? 10,
          select: {
            id: true,
            status: true,
            input: true,
            output: true,
            error: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  taskId: params.id,
                  count: runs.length,
                  runs: runs.map(
                    (r: {
                      id: string;
                      status: string;
                      input: string | null;
                      output: string | null;
                      error: string | null;
                      startedAt: Date | null;
                      completedAt: Date | null;
                    }) => ({
                      id: r.id,
                      status: r.status,
                      input: r.input ? JSON.parse(r.input) : null,
                      output: r.output ? JSON.parse(r.output) : null,
                      error: r.error,
                      startedAt: r.startedAt?.toISOString(),
                      completedAt: r.completedAt?.toISOString(),
                      duration:
                        r.startedAt && r.completedAt
                          ? r.completedAt.getTime() - r.startedAt.getTime()
                          : null,
                    }),
                  ),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: runs.length },
        };
      },
    }),

    // ─── task_types ─────────────────────────────────────────────────────────

    defineTool({
      name: "task_types",
      label: "List Task Types",
      description:
        "List all available task types that can be created, with their descriptions, config fields, and default schedules.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params) => {
        // Fetch email accounts for context on accountId fields
        const accounts = await prisma.emailAccount.findMany({
          where: { userId, enabled: true },
          select: { id: true, email: true },
        });
        const accountLabels = accounts.map((a) => a.email);

        const types = jobTypeSchemas.map((schema) => {
          const fields = schema.fields.map((field) => {
            const info: Record<string, unknown> = {
              key: field.key,
              label: field.label,
              description: field.description,
              type: field.type,
              default: field.default,
            };
            if (field.key === "accountId" && accountLabels.length > 0) {
              info.availableAccounts = accountLabels;
            }
            if (field.min !== undefined) info.min = field.min;
            if (field.max !== undefined) info.max = field.max;
            return info;
          });

          return {
            type: schema.type,
            label: schema.label,
            description: schema.description,
            usesAi: schema.usesAi ?? false,
            defaultCron: schema.defaultCron,
            fields,
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ count: types.length, types }, null, 2),
            },
          ],
          details: { count: types.length },
        };
      },
    }),

    // ─── task_create ────────────────────────────────────────────────────────

    defineTool({
      name: "task_create",
      label: "Create Task",
      description:
        "Create a new scheduled task. Use 'task_types' first to see available types and their config fields. The 'config' object should include 'cronExpression' (required) plus any type-specific fields.",
      parameters: Type.Object({
        type: Type.String({
          description:
            "Task type identifier. Use 'task_types' to see available types (e.g. 'summarization', 'email_sync', 'calendar_sync').",
        }),
        config: Type.Object({
          cronExpression: Type.String({
            description: "Cron schedule expression (e.g. '*/30 * * * *' for every 30 minutes).",
          }),
        }),
        enabled: Type.Optional(
          Type.Boolean({
            description: "Whether the task is enabled on creation. Default: true.",
            default: true,
          }),
        ),
        modelId: Type.Optional(
          Type.String({
            description: "Override the default AI model for this task (for AI-powered task types).",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const schema = jobTypeSchemas.find((s) => s.type === params.type);
        if (!schema) {
          const available = jobTypeSchemas.map((s) => s.type).join(", ");
          throw new Error(
            `Unknown task type "${params.type}". Available types: ${available}. Use 'task_types' for details.`,
          );
        }

        if (!params.config.cronExpression) {
          throw new Error("cronExpression is required in config");
        }

        // Build config: merge schema defaults + provided values
        const defaults: Record<string, unknown> = Object.fromEntries(
          schema.fields.map((f) => [f.key, f.default]),
        );

        const mergedConfig: Record<string, unknown> = {
          ...defaults,
          ...params.config,
        };

        // Remove empty string values for optional fields
        for (const key of Object.keys(mergedConfig)) {
          if (mergedConfig[key] === "") {
            delete mergedConfig[key];
          }
        }

        // Extract modelId (top-level param overrides config)
        const resolvedModelId =
          params.modelId ?? (mergedConfig.modelId as string | undefined) ?? null;
        delete mergedConfig.modelId;

        const job = await prisma.queueTask.create({
          data: {
            userId,
            type: params.type,
            enabled: params.enabled !== false,
            modelId: resolvedModelId,
            config: JSON.stringify(mergedConfig),
          },
        });

        // Register with BullMQ if enabled
        if (job.enabled && mergedConfig.cronExpression) {
          const queue = getQueue();
          await queue
            .add(
              "execute",
              {
                ...mergedConfig,
                taskId: job.id,
                type: job.type,
                modelId: job.modelId,
              },
              {
                jobId: `scheduled-${job.id}`,
                repeat: { pattern: mergedConfig.cronExpression as string, tz: "UTC" },
              },
            )
            .catch((err) => {
              console.error(`Failed to schedule task ${job.id}: ${err.message}`);
            });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  created: true,
                  task: {
                    id: job.id,
                    type: job.type,
                    enabled: job.enabled,
                    modelId: job.modelId,
                    config: JSON.parse(job.config) as Record<string, unknown>,
                    createdAt: job.createdAt.toISOString(),
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: { id: job.id },
        };
      },
    }),
  ];
}
