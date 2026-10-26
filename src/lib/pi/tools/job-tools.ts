import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { prisma } from "@/lib/db";
import { syncQueueTaskSchedule, triggerQueueTaskRun, unscheduleQueueTask } from "@/lib/queue";
import { jobTypeSchemas } from "@/lib/queue/job-schemas";
import { buildModelRuntime } from "@/lib/pi/models";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";
import { toStoredModelId } from "@/lib/pi/model-id";

/** A job as job_list reports it (config parsed, dates as ISO strings). */
const jobListEntrySchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  enabled: Type.Boolean(),
  modelId: Type.Union([Type.String(), Type.Null()]),
  config: Type.Record(Type.String(), Type.Unknown()),
  // Omitted when the job has never run.
  lastRunAt: Type.Optional(Type.String()),
  runCount: Type.Integer(),
  createdAt: Type.String(),
});

const jobListSchema = Type.Object({
  count: Type.Integer(),
  jobs: Type.Array(jobListEntrySchema),
});

const jobEnableSchema = Type.Object({
  id: Type.String(),
  enabled: Type.Boolean(),
});

const jobRunSchema = Type.Object({
  queued: Type.Boolean(),
  jobId: Type.String(),
  runId: Type.String(),
});

/** One run in a job's history. */
const jobLogRunSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  // Parsed JSON payloads; null when the run has none.
  input: Type.Unknown(),
  output: Type.Unknown(),
  error: Type.Union([Type.String(), Type.Null()]),
  // Omitted until the run starts/finishes.
  startedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
  duration: Type.Union([Type.Number(), Type.Null()]),
});

const jobLogsSchema = Type.Object({
  jobId: Type.String(),
  count: Type.Integer(),
  runs: Type.Array(jobLogRunSchema),
});

/** A configurable field of a job type, for the dynamic create form. */
const jobTypeFieldSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
  description: Type.Optional(Type.String()),
  type: Type.String(),
  default: Type.Optional(Type.Unknown()),
  availableAccounts: Type.Optional(Type.Array(Type.String())),
  min: Type.Optional(Type.Number()),
  max: Type.Optional(Type.Number()),
});

const jobTypesSchema = Type.Object({
  count: Type.Integer(),
  types: Type.Array(
    Type.Object({
      type: Type.String(),
      label: Type.String(),
      description: Type.String(),
      usesAi: Type.Boolean(),
      defaultCron: Type.String(),
      fields: Type.Array(jobTypeFieldSchema),
    }),
  ),
});

/** A newly created job as job_create reports it. */
const jobCreatedSchema = Type.Object({
  created: Type.Boolean(),
  job: Type.Object({
    id: Type.String(),
    type: Type.String(),
    enabled: Type.Boolean(),
    modelId: Type.Union([Type.String(), Type.Null()]),
    config: Type.Record(Type.String(), Type.Unknown()),
    createdAt: Type.String(),
  }),
});

const modelListSchema = Type.Object({
  count: Type.Integer(),
  providers: Type.Array(
    Type.Object({
      provider: Type.String(),
      models: Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          modelId: Type.String(),
        }),
      ),
    }),
  ),
  defaults: Type.Object({
    user: Type.Union([
      Type.Object({
        provider: Type.String(),
        model: Type.Union([Type.String(), Type.Null()]),
      }),
      Type.Null(),
    ]),
    jobs: Type.Union([Type.Object({ provider: Type.String(), model: Type.String() }), Type.Null()]),
  }),
});

/** A job after an update, as job_update reports it. */
const jobUpdatedSchema = Type.Object({
  updated: Type.Boolean(),
  job: Type.Object({
    id: Type.String(),
    type: Type.String(),
    enabled: Type.Boolean(),
    modelId: Type.Union([Type.String(), Type.Null()]),
    config: Type.Record(Type.String(), Type.Unknown()),
  }),
});

const jobDeleteSchema = Type.Object({
  deleted: Type.Boolean(),
  id: Type.String(),
});

/**
 * Create job tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's jobs.
 * Returns an array of tool definitions for direct spread into the agent session.
 * Tool names use "job_*" to match the frontend "Jobs" sidebar label.
 */
export function createJobTools(userId: string): ToolDefinition[] {
  return [
    // ─── job_list ───────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_list",
      label: "List Jobs",
      description: "List all configured jobs with their current status, schedule, and run count.",
      parameters: Type.Object({
        enabled: Type.Optional(
          Type.Boolean({
            description: "Filter by enabled/disabled status.",
          }),
        ),
        type: Type.Optional(
          Type.String({
            description:
              "Filter by job type (e.g. 'summarization', 'classification', 'spam_filtering').",
          }),
        ),
      }),
      outputSchema: jobListSchema,
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
          value: {
            count: jobs.length,
            jobs: jobs.map(
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
                ...(j.lastRunAt ? { lastRunAt: j.lastRunAt.toISOString() } : {}),
                runCount: j.runCount,
                createdAt: j.createdAt.toISOString(),
              }),
            ),
          },
          details: { count: jobs.length },
        };
      },
    }),

    // ─── job_enable ─────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_enable",
      label: "Enable/Disable Job",
      description: "Enable or disable a job by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job ID.",
        }),
        enabled: Type.Boolean({
          description: "Whether to enable (true) or disable (false) the job.",
        }),
      }),
      outputSchema: jobEnableSchema,
      execute: async (_toolCallId, params) => {
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
        });

        if (!job) {
          throw new Error(`Job ${params.id} not found`);
        }

        await prisma.queueTask.update({
          where: { id: params.id },
          data: { enabled: params.enabled },
        });

        // Update BullMQ schedule (remove-then-add if still scheduled)
        await syncQueueTaskSchedule({
          id: job.id,
          type: job.type,
          enabled: params.enabled,
          modelId: job.modelId,
          config: job.config,
        }).catch((err) => {
          console.error(`Failed to update schedule for job ${params.id}:`, err);
        });

        return {
          value: {
            id: params.id,
            enabled: params.enabled,
          },
          details: { id: params.id, enabled: params.enabled },
        };
      },
    }),

    // ─── job_run ────────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_run",
      label: "Run Job Now",
      description: "Trigger an immediate manual run of a job by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job ID to run.",
        }),
      }),
      outputSchema: jobRunSchema,
      execute: async (_toolCallId, params) => {
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
        });

        if (!job) {
          throw new Error(`Job ${params.id} not found`);
        }

        const { runId } = await triggerQueueTaskRun(job);

        return {
          value: {
            queued: true,
            jobId: params.id,
            runId,
          },
          details: { queued: true, runId },
        };
      },
    }),

    // ─── job_logs ───────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_logs",
      label: "Job Logs",
      description: "View recent run history for a job, including status, output, and errors.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job ID.",
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
      outputSchema: jobLogsSchema,
      execute: async (_toolCallId, params) => {
        // Verify the job belongs to this user
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
          select: { id: true },
        });

        if (!job) {
          throw new Error(`Job ${params.id} not found`);
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
          value: {
            jobId: params.id,
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
                ...(r.startedAt ? { startedAt: r.startedAt.toISOString() } : {}),
                ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
                duration:
                  r.startedAt && r.completedAt
                    ? r.completedAt.getTime() - r.startedAt.getTime()
                    : null,
              }),
            ),
          },
          details: { count: runs.length },
        };
      },
    }),

    // ─── job_types ──────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_types",
      label: "List Job Types",
      description:
        "List all available job types that can be created, with their descriptions, config fields, and default schedules.",
      parameters: Type.Object({}),
      outputSchema: jobTypesSchema,
      execute: async (_toolCallId, _params) => {
        // Fetch email accounts for context on accountId fields
        const accounts = await prisma.emailAccount.findMany({
          where: { userId, enabled: true },
          select: { id: true, email: true },
        });
        const accountLabels = accounts.map((a) => a.email);

        const types = jobTypeSchemas.map((schema) => {
          const fields = schema.fields.map((field) => {
            const info: Static<typeof jobTypeFieldSchema> = {
              key: field.key,
              label: field.label,
              ...(field.description !== undefined ? { description: field.description } : {}),
              type: field.type,
              ...(field.default !== undefined ? { default: field.default } : {}),
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
          value: { count: types.length, types },
          details: { count: types.length },
        };
      },
    }),

    // ─── job_create ─────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_create",
      label: "Create Job",
      description:
        "Create a new scheduled job. Use 'job_types' first to see available types and their config fields. The 'config' object should include 'cronExpression' (required) plus any type-specific fields.",
      parameters: Type.Object({
        type: Type.String({
          description:
            "Job type identifier. Use 'job_types' to see available types (e.g. 'summarization', 'email_sync', 'calendar_sync').",
        }),
        config: Type.Object({
          cronExpression: Type.String({
            description: "Cron schedule expression (e.g. '*/30 * * * *' for every 30 minutes).",
          }),
        }),
        enabled: Type.Optional(
          Type.Boolean({
            description: "Whether the job is enabled on creation. Default: true.",
            default: true,
          }),
        ),
        modelId: Type.Optional(
          Type.String({
            description:
              "Override the default AI model for this job (format: 'provider:modelId'). Use 'model_list' to see available models and their modelId values.",
          }),
        ),
      }),
      outputSchema: jobCreatedSchema,
      execute: async (_toolCallId, params) => {
        const schema = jobTypeSchemas.find((s) => s.type === params.type);
        if (!schema) {
          const available = jobTypeSchemas.map((s) => s.type).join(", ");
          throw new Error(
            `Unknown job type "${params.type}". Available types: ${available}. Use 'job_types' for details.`,
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

        // Top-level param overrides the config value.
        const rawModelId = (params.modelId ?? mergedConfig.modelId) as string | undefined | null;
        const resolvedModelId = rawModelId ? toStoredModelId(rawModelId) : null;
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
        await syncQueueTaskSchedule(job).catch((err) => {
          console.error(`Failed to schedule job ${job.id}: ${err.message}`);
        });

        return {
          value: {
            created: true,
            job: {
              id: job.id,
              type: job.type,
              enabled: job.enabled,
              modelId: job.modelId,
              config: JSON.parse(job.config) as Record<string, unknown>,
              createdAt: job.createdAt.toISOString(),
            },
          },
          details: { id: job.id },
        };
      },
    }),

    // ─── model_list ────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "model_list",
      label: "List Models",
      description:
        "List all available AI models for this user. Use this to find valid model IDs before creating or updating jobs. Each model includes a 'modelId' field in 'provider:model' format that you can pass directly to job_create or job_update. Returns models grouped by provider, filtered by admin config.",
      parameters: Type.Object({}),
      outputSchema: modelListSchema,
      execute: async (_toolCallId, _params) => {
        const { models } = await buildModelRuntime(userId);

        // Group by provider
        const byProvider = new Map<string, Array<{ id: string; name: string; modelId: string }>>();
        for (const m of models) {
          if (!byProvider.has(m.provider)) {
            byProvider.set(m.provider, []);
          }
          byProvider
            .get(m.provider)!
            .push({ id: m.id, name: m.name, modelId: `${m.provider}:${m.id}` });
        }

        // Also fetch user default + job default for context
        const settings = await prisma.appSettings.findUnique({
          where: { userId },
          select: {
            defaultModelProvider: true,
            defaultModelName: true,
            purposeModelOverrides: true,
          },
        });

        const overrides = settings?.purposeModelOverrides as Record<
          string,
          { provider: string; model: string }
        > | null;

        return {
          value: {
            count: models.length,
            providers: Array.from(byProvider.entries()).map(([provider, modelList]) => ({
              provider,
              models: modelList,
            })),
            defaults: {
              user: settings?.defaultModelProvider
                ? {
                    provider: settings.defaultModelProvider,
                    model: settings.defaultModelName,
                  }
                : null,
              jobs: overrides?.jobs
                ? {
                    provider: overrides.jobs.provider,
                    model: overrides.jobs.model,
                  }
                : null,
            },
          },
          details: { count: models.length },
        };
      },
    }),

    // ─── job_update ────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_update",
      label: "Update Job",
      description:
        "Update an existing job's configuration. Can change the model, schedule, enabled state, or type-specific config fields. Use 'job_list' to find job IDs and 'job_types' to see valid config fields.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job ID to update.",
        }),
        modelId: Type.Optional(
          Type.String({
            description:
              "Override the AI model for this job (format: 'provider:modelId'). Use 'model_list' to see available models. Pass null or omit to use the default.",
          }),
        ),
        enabled: Type.Optional(
          Type.Boolean({
            description: "Enable or disable the job.",
          }),
        ),
        config: Type.Optional(
          Type.Object({
            cronExpression: Type.Optional(
              Type.String({
                description: "Cron schedule expression (e.g. '*/30 * * * *').",
              }),
            ),
          }),
        ),
      }),
      outputSchema: jobUpdatedSchema,
      execute: async (_toolCallId, params) => {
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
        });

        if (!job) {
          throw new Error(`Job ${params.id} not found`);
        }

        const existingConfig = JSON.parse(job.config) as Record<string, unknown>;
        const newConfig = { ...existingConfig };
        let newModelId = job.modelId;
        let newEnabled = job.enabled;

        if (params.modelId !== undefined) {
          newModelId = params.modelId ? toStoredModelId(params.modelId) : null;
        }

        // Update enabled
        if (params.enabled !== undefined) {
          newEnabled = params.enabled;
        }

        // Merge config changes
        if (params.config) {
          if (params.config.cronExpression !== undefined) {
            newConfig.cronExpression = params.config.cronExpression;
          }
          // Merge any other top-level config fields passed
          for (const [key, value] of Object.entries(params.config)) {
            if (key !== "cronExpression") {
              newConfig[key] = value;
            }
          }
        }

        // Update the database
        await prisma.queueTask.update({
          where: { id: params.id },
          data: {
            ...(newModelId !== job.modelId ? { modelId: newModelId } : {}),
            ...(newEnabled !== job.enabled ? { enabled: newEnabled } : {}),
            ...(JSON.stringify(newConfig) !== job.config
              ? { config: JSON.stringify(newConfig) }
              : {}),
          },
        });

        // Update BullMQ scheduler. remove existing first, then re-add if scheduled
        await syncQueueTaskSchedule({
          id: params.id,
          type: job.type,
          enabled: newEnabled,
          modelId: newModelId,
          config: JSON.stringify(newConfig),
        }).catch((err) => {
          console.error(`Failed to re-schedule job ${params.id}: ${err.message}`);
        });

        return {
          value: {
            updated: true,
            job: {
              id: params.id,
              type: job.type,
              enabled: newEnabled,
              modelId: newModelId,
              config: newConfig,
            },
          },
          details: { id: params.id },
        };
      },
    }),

    // ─── job_delete ────────────────────────────────────────────────────────

    defineStructuredTool({
      name: "job_delete",
      label: "Delete Job",
      description: "Permanently delete a job and remove its schedule. This cannot be undone.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job ID to delete.",
        }),
      }),
      outputSchema: jobDeleteSchema,
      execute: async (_toolCallId, params) => {
        const job = await prisma.queueTask.findFirst({
          where: { id: params.id, userId },
        });

        if (!job) {
          throw new Error(`Job ${params.id} not found`);
        }

        // Remove BullMQ scheduler
        await unscheduleQueueTask(params.id);

        // Delete from database (cascades to TaskRun records)
        await prisma.queueTask.delete({
          where: { id: params.id },
        });

        return {
          value: {
            deleted: true,
            id: params.id,
          },
          details: { id: params.id },
        };
      },
    }),
  ];
}
