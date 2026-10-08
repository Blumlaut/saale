import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { triggerAgentRun } from "@/lib/agent-jobs/run";
import { scheduleAgentDefinition, unscheduleAgentDefinition } from "@/lib/queue";
import {
  isReservedAgentName,
  RESERVED_AGENT_NAME_ERROR,
  SYSTEM_MANAGED_ERROR,
} from "@/lib/agent-jobs/system-managed";
import { normalizeRunAt } from "@/lib/agent-jobs/schedule";
import { defineStructuredTool } from "@/lib/pi/tools/tool-result";

/**
 * An agent job definition as list, create and update report it. The three tools
 * embed the same definition, so its fields live here once; each tool adds only
 * the timestamps and counters it returns.
 */
const AGENT_JOB_DEFINITION_SCHEMA = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  prompt: Type.String(),
  systemPrompt: Type.Union([Type.String(), Type.Null()]),
  toolConfig: Type.Union([Type.Record(Type.String(), Type.Boolean()), Type.Null()]),
  modelId: Type.Union([Type.String(), Type.Null()]),
  outputChannel: Type.Union([Type.String(), Type.Null()]),
  outputChannelId: Type.Union([Type.String(), Type.Null()]),
  cronExpression: Type.Union([Type.String(), Type.Null()]),
  runAt: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Boolean(),
});

/** A definition with its run history, as agent_job_list reports it. */
const AGENT_JOB_LIST_ENTRY_SCHEMA = Type.Object({
  ...AGENT_JOB_DEFINITION_SCHEMA.properties,
  // Omitted when the job has never run.
  lastRunAt: Type.Optional(Type.String()),
  runCount: Type.Integer(),
  createdAt: Type.String(),
});

const AGENT_JOB_LIST_SCHEMA = Type.Object({
  count: Type.Integer(),
  jobs: Type.Array(AGENT_JOB_LIST_ENTRY_SCHEMA),
});

/** The definition agent_job_create writes, plus the row's creation time. */
const AGENT_JOB_CREATED_SCHEMA = Type.Object({
  ...AGENT_JOB_DEFINITION_SCHEMA.properties,
  createdAt: Type.String(),
});

const AGENT_JOB_CREATE_SCHEMA = Type.Object({
  created: Type.Boolean(),
  job: AGENT_JOB_CREATED_SCHEMA,
});

/** The definition agent_job_update writes, plus the row's update time. */
const AGENT_JOB_UPDATED_SCHEMA = Type.Object({
  ...AGENT_JOB_DEFINITION_SCHEMA.properties,
  updatedAt: Type.String(),
});

const AGENT_JOB_UPDATE_SCHEMA = Type.Object({
  updated: Type.Boolean(),
  job: AGENT_JOB_UPDATED_SCHEMA,
});

const AGENT_JOB_DELETE_SCHEMA = Type.Object({
  deleted: Type.Boolean(),
  id: Type.String(),
});

const AGENT_JOB_RUN_SCHEMA = Type.Object({
  queued: Type.Boolean(),
  runId: Type.String(),
  jobId: Type.String(),
});

/** One run in an agent job's history. */
const AGENT_JOB_RUN_LOG_SCHEMA = Type.Object({
  id: Type.String(),
  status: Type.String(),
  prompt: Type.String(),
  modelId: Type.Union([Type.String(), Type.Null()]),
  inputTokens: Type.Integer(),
  outputTokens: Type.Integer(),
  cost: Type.Number(),
  error: Type.Union([Type.String(), Type.Null()]),
  // Omitted until the run starts/finishes.
  startedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
  duration: Type.Union([Type.Number(), Type.Null()]),
  createdAt: Type.String(),
});

const AGENT_JOB_LOGS_SCHEMA = Type.Object({
  jobId: Type.String(),
  count: Type.Integer(),
  runs: Type.Array(AGENT_JOB_RUN_LOG_SCHEMA),
});

/** One recorded tool call in a run's transcript, parsed from the stored JSON. */
const AGENT_JOB_TOOL_CALL_SCHEMA = Type.Object({
  id: Type.String(),
  name: Type.String(),
  args: Type.Record(Type.String(), Type.Unknown()),
  // Absent when the run was saved before the call reported a result.
  result: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
});

/** One message in a run's transcript. */
const AGENT_RUN_MESSAGE_SCHEMA = Type.Object({
  id: Type.String(),
  role: Type.String(),
  content: Type.String(),
  thinking: Type.Union([Type.String(), Type.Null()]),
  toolCalls: Type.Union([Type.Array(AGENT_JOB_TOOL_CALL_SCHEMA), Type.Null()]),
  createdAt: Type.String(),
});

const AGENT_RUN_MESSAGES_SCHEMA = Type.Object({
  runId: Type.String(),
  count: Type.Integer(),
  messages: Type.Array(AGENT_RUN_MESSAGE_SCHEMA),
});

/**
 * Create agent job tools with userId injection for user isolation.
 * Allows the agent to create, list, run, update, and inspect agent job definitions.
 */
export function createAgentJobTools(userId: string): ToolDefinition[] {
  return [
    // ─── agent_job_list ─────────────────────────────────────────────────────

    defineStructuredTool({
      name: "agent_job_list",
      label: "List Agent Jobs",
      description:
        "List all agent job definitions with their status, run count, output channel, and schedule.",
      parameters: Type.Object({
        enabled: Type.Optional(
          Type.Boolean({
            description: "Filter by enabled/disabled status.",
          }),
        ),
      }),
      outputSchema: AGENT_JOB_LIST_SCHEMA,
      execute: async (_toolCallId, params) => {
        const where: Record<string, unknown> = { userId };
        if (params.enabled !== undefined) {
          where.enabled = params.enabled;
        }

        const definitions = await prisma.agentDefinition.findMany({
          where,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            description: true,
            prompt: true,
            systemPrompt: true,
            toolConfig: true,
            modelId: true,
            outputChannel: true,
            outputChannelId: true,
            cronExpression: true,
            runAt: true,
            lastRunAt: true,
            enabled: true,
            _count: { select: { runs: true } },
            createdAt: true,
          },
        });

        return {
          value: {
            count: definitions.length,
            jobs: definitions.map((d) => ({
              id: d.id,
              name: d.name,
              description: d.description,
              prompt: d.prompt,
              systemPrompt: d.systemPrompt,
              toolConfig: d.toolConfig as Record<string, boolean> | null,
              modelId: d.modelId,
              outputChannel: d.outputChannel,
              outputChannelId: d.outputChannelId,
              cronExpression: d.cronExpression,
              runAt: d.runAt?.toISOString() ?? null,
              ...(d.lastRunAt ? { lastRunAt: d.lastRunAt.toISOString() } : {}),
              enabled: d.enabled,
              runCount: d._count.runs,
              createdAt: d.createdAt.toISOString(),
            })),
          },
          details: { count: definitions.length },
        };
      },
    }),

    // ─── agent_job_create ───────────────────────────────────────────────────

    defineStructuredTool({
      name: "agent_job_create",
      label: "Create Agent Job",
      description:
        "Create a new agent job definition. Requires: name, prompt. Optional: description, systemPrompt, toolConfig, modelId, outputChannel, outputChannelId, cronExpression.",
      parameters: Type.Object({
        name: Type.String({
          description: "Job name (max 100 chars, unique per user).",
          maxLength: 100,
        }),
        prompt: Type.String({
          description: "The prompt sent to the agent on each run.",
        }),
        description: Type.Optional(
          Type.String({
            description: "Optional description of what this job does.",
          }),
        ),
        systemPrompt: Type.Optional(
          Type.String({
            description:
              "Optional system prompt override. Defaults to a generic job-oriented prompt.",
          }),
        ),
        toolConfig: Type.Optional(
          Type.Object(
            {
              email: Type.Optional(Type.Boolean()),
              calendar: Type.Optional(Type.Boolean()),
              jobs: Type.Optional(Type.Boolean()),
              chatSearch: Type.Optional(Type.Boolean()),
              web: Type.Optional(Type.Boolean()),
              memory: Type.Optional(Type.Boolean()),
              tasks: Type.Optional(Type.Boolean()),
              telegram: Type.Optional(Type.Boolean()),
            },
            {
              description:
                "Which tool categories to expose. Available: email, calendar, jobs, chatSearch, web, memory, tasks, telegram. Enable telegram so the run can message the user itself.",
            },
          ),
        ),
        modelId: Type.Optional(
          Type.String({
            description: "Model override (format: 'provider:modelId').",
          }),
        ),
        outputChannel: Type.Optional(
          Type.String({
            description:
              "Output channel for agent responses (e.g., 'telegram'). If set, the agent's output is sent to this channel.",
          }),
        ),
        outputChannelId: Type.Optional(
          Type.String({
            description:
              "Target identifier for the output channel (e.g., Telegram chat ID for 'telegram' channel). For 'telegram', omit this to inherit the user's configured chat.",
          }),
        ),
        cronExpression: Type.Optional(
          Type.String({
            description:
              "Cron expression for recurring runs (e.g., '0 9 * * *' for daily at 9am). Null for manual-only jobs. Mutually exclusive with runAt.",
          }),
        ),
        runAt: Type.Optional(
          Type.String({
            description:
              "ISO 8601 timestamp for a one-off run (e.g. '2026-10-07T15:00:00Z'). The job runs once at that time — use this for reminders. Mutually exclusive with cronExpression.",
          }),
        ),
      }),
      outputSchema: AGENT_JOB_CREATE_SCHEMA,
      execute: async (_toolCallId, params) => {
        if (isReservedAgentName(params.name)) {
          throw new Error(RESERVED_AGENT_NAME_ERROR);
        }

        // Normalize modelId
        const rawModelId = params.modelId || null;
        const resolvedModelId = rawModelId?.includes("/")
          ? rawModelId.replace("/", ":")
          : rawModelId;

        let runAt: Date | null;
        try {
          runAt = normalizeRunAt(params.runAt);
        } catch (err) {
          throw new Error((err as Error).message);
        }
        const cronExpression = runAt ? null : params.cronExpression || null;

        const definition = await prisma.agentDefinition.create({
          data: {
            userId,
            name: params.name.trim(),
            description: params.description?.trim() || null,
            prompt: params.prompt.trim(),
            systemPrompt: params.systemPrompt?.trim() || null,
            toolConfig: (params.toolConfig as Record<string, boolean>) ?? null,
            modelId: resolvedModelId,
            outputChannel: params.outputChannel || null,
            outputChannelId: params.outputChannelId || null,
            cronExpression,
            runAt,
          },
        });

        // Register the BullMQ schedule if the definition has one
        if (definition.enabled && (definition.runAt || definition.cronExpression)) {
          await scheduleAgentDefinition(definition).catch((err) => {
            console.error(
              `Failed to schedule agent definition ${definition.id} (${definition.runAt?.toISOString() ?? definition.cronExpression}):`,
              err,
            );
          });
        }

        return {
          value: {
            created: true,
            job: {
              id: definition.id,
              name: definition.name,
              description: definition.description,
              prompt: definition.prompt,
              systemPrompt: definition.systemPrompt,
              toolConfig: definition.toolConfig as Record<string, boolean> | null,
              modelId: definition.modelId,
              outputChannel: definition.outputChannel,
              outputChannelId: definition.outputChannelId,
              cronExpression: definition.cronExpression,
              runAt: definition.runAt?.toISOString() ?? null,
              enabled: definition.enabled,
              createdAt: definition.createdAt.toISOString(),
            },
          },
          details: { id: definition.id },
        };
      },
    }),

    // ─── agent_job_update ───────────────────────────────────────────────────

    defineStructuredTool({
      name: "agent_job_update",
      label: "Update Agent Job",
      description: "Update an existing agent job definition. Only provided fields are updated.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job definition ID.",
        }),
        name: Type.Optional(
          Type.String({
            description: "New job name.",
            maxLength: 100,
          }),
        ),
        prompt: Type.Optional(
          Type.String({
            description: "New prompt.",
          }),
        ),
        description: Type.Optional(
          Type.String({
            description: "New description.",
          }),
        ),
        systemPrompt: Type.Optional(
          Type.String({
            description: "New system prompt.",
          }),
        ),
        toolConfig: Type.Optional(
          Type.Object(
            {
              email: Type.Optional(Type.Boolean()),
              calendar: Type.Optional(Type.Boolean()),
              jobs: Type.Optional(Type.Boolean()),
              chatSearch: Type.Optional(Type.Boolean()),
              web: Type.Optional(Type.Boolean()),
              memory: Type.Optional(Type.Boolean()),
              tasks: Type.Optional(Type.Boolean()),
              telegram: Type.Optional(Type.Boolean()),
            },
            {
              description: "Updated tool categories.",
            },
          ),
        ),
        modelId: Type.Optional(
          Type.String({
            description: "Model override. Pass empty string to clear.",
          }),
        ),
        outputChannel: Type.Optional(
          Type.String({
            description: "Output channel. Pass empty string to clear.",
          }),
        ),
        outputChannelId: Type.Optional(
          Type.String({
            description:
              "Output channel target ID. Pass empty string to clear. For 'telegram', pass empty string to inherit the user's configured chat.",
          }),
        ),
        cronExpression: Type.Optional(
          Type.String({
            description: "Cron expression. Pass empty string to clear.",
          }),
        ),
        runAt: Type.Optional(
          Type.String({
            description:
              "ISO 8601 timestamp for a one-off run. Pass empty string to clear. Mutually exclusive with cronExpression.",
          }),
        ),
        enabled: Type.Optional(
          Type.Boolean({
            description: "Enable or disable the job.",
          }),
        ),
      }),
      outputSchema: AGENT_JOB_UPDATE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const definition = await prisma.agentDefinition.findFirst({
          where: { id: params.id, userId },
        });
        if (!definition) {
          throw new Error(`Agent job ${params.id} not found`);
        }
        if (definition.systemManaged) {
          throw new Error(SYSTEM_MANAGED_ERROR);
        }

        const data: Record<string, unknown> = {};

        if (params.name !== undefined) {
          if (isReservedAgentName(params.name)) {
            throw new Error(RESERVED_AGENT_NAME_ERROR);
          }
          data.name = params.name.trim();
        }
        if (params.prompt !== undefined) data.prompt = params.prompt.trim();
        if (params.description !== undefined) data.description = params.description?.trim() || null;
        if (params.systemPrompt !== undefined)
          data.systemPrompt = params.systemPrompt?.trim() || null;
        if (params.toolConfig !== undefined)
          data.toolConfig = params.toolConfig as Record<string, boolean>;
        if (params.modelId !== undefined) {
          const raw = params.modelId;
          data.modelId = raw ? (raw.includes("/") ? raw.replace("/", ":") : raw) : null;
        }
        if (params.outputChannel !== undefined) data.outputChannel = params.outputChannel || null;
        if (params.outputChannelId !== undefined)
          data.outputChannelId = params.outputChannelId || null;
        if (params.cronExpression !== undefined || params.runAt !== undefined) {
          let nextRunAt = definition.runAt;
          let nextCron = definition.cronExpression;
          try {
            if (params.runAt !== undefined) nextRunAt = normalizeRunAt(params.runAt);
          } catch (err) {
            throw new Error((err as Error).message);
          }
          if (params.cronExpression !== undefined) nextCron = params.cronExpression || null;
          if (params.runAt !== undefined && nextRunAt) {
            nextCron = null;
          } else if (nextCron) {
            nextRunAt = null;
          }
          data.cronExpression = nextCron;
          data.runAt = nextRunAt;
        }
        if (params.enabled !== undefined) data.enabled = params.enabled;

        const updated = await prisma.agentDefinition.update({
          where: { id: params.id },
          data,
        });

        // Resync the BullMQ schedule: BullMQ does not update an existing
        // scheduler with the same jobId, so remove first, then re-add if scheduled.
        await unscheduleAgentDefinition(updated.id);
        if (updated.enabled && (updated.runAt || updated.cronExpression)) {
          await scheduleAgentDefinition(updated).catch((err) => {
            console.error(
              `Failed to re-schedule agent definition ${updated.id} (${updated.runAt?.toISOString() ?? updated.cronExpression}):`,
              err,
            );
          });
        }

        return {
          value: {
            updated: true,
            job: {
              id: updated.id,
              name: updated.name,
              description: updated.description,
              prompt: updated.prompt,
              systemPrompt: updated.systemPrompt,
              toolConfig: updated.toolConfig as Record<string, boolean> | null,
              modelId: updated.modelId,
              outputChannel: updated.outputChannel,
              outputChannelId: updated.outputChannelId,
              cronExpression: updated.cronExpression,
              runAt: updated.runAt?.toISOString() ?? null,
              enabled: updated.enabled,
              updatedAt: updated.updatedAt.toISOString(),
            },
          },
          details: { id: updated.id },
        };
      },
    }),

    // ─── agent_job_delete ───────────────────────────────────────────────────

    defineStructuredTool({
      name: "agent_job_delete",
      label: "Delete Agent Job",
      description: "Delete an agent job definition and all its runs.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job definition ID.",
        }),
      }),
      outputSchema: AGENT_JOB_DELETE_SCHEMA,
      execute: async (_toolCallId, params) => {
        const definition = await prisma.agentDefinition.findFirst({
          where: { id: params.id, userId },
        });
        if (!definition) {
          throw new Error(`Agent job ${params.id} not found`);
        }
        if (definition.systemManaged) {
          throw new Error(SYSTEM_MANAGED_ERROR);
        }

        await prisma.agentDefinition.delete({
          where: { id: params.id },
        });

        // Remove the BullMQ repeatable job so the deleted definition stops firing
        await unscheduleAgentDefinition(params.id);

        return {
          value: { deleted: true, id: params.id },
          details: { id: params.id },
        };
      },
    }),

    // ─── agent_job_run ──────────────────────────────────────────────────────

    defineStructuredTool({
      name: "agent_job_run",
      label: "Run Agent Job",
      description: "Trigger an immediate run of an agent job by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job definition ID.",
        }),
        prompt: Type.Optional(
          Type.String({
            description:
              "Override the default prompt for this run. If not provided, uses the definition's prompt.",
          }),
        ),
      }),
      outputSchema: AGENT_JOB_RUN_SCHEMA,
      execute: async (_toolCallId, params) => {
        const definition = await prisma.agentDefinition.findFirst({
          where: { id: params.id, userId },
          select: { id: true, enabled: true, systemManaged: true },
        });
        if (!definition) {
          throw new Error(`Agent job ${params.id} not found`);
        }
        if (definition.systemManaged) {
          throw new Error(SYSTEM_MANAGED_ERROR);
        }
        if (!definition.enabled) {
          throw new Error(`Agent job ${params.id} is disabled`);
        }

        // Create the run record and dispatch execution (fire-and-forget)
        const run = await triggerAgentRun({
          definitionId: params.id,
          userId,
          ...(params.prompt ? { promptOverride: params.prompt } : {}),
        });

        return {
          value: {
            queued: true,
            runId: run.id,
            jobId: params.id,
          },
          details: { runId: run.id },
        };
      },
    }),

    // ─── agent_job_logs ─────────────────────────────────────────────────────

    defineStructuredTool({
      name: "agent_job_logs",
      label: "Agent Job Logs",
      description:
        "View recent runs for an agent job, including status, token usage, cost, and errors.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job definition ID.",
        }),
        limit: Type.Optional(
          Type.Integer({
            description: "Number of recent runs to return. Default: 10.",
            default: 10,
          }),
        ),
        status: Type.Optional(
          Type.String({
            description: "Filter by status: 'pending', 'running', 'completed', 'error'.",
          }),
        ),
      }),
      outputSchema: AGENT_JOB_LOGS_SCHEMA,
      execute: async (_toolCallId, params) => {
        const definition = await prisma.agentDefinition.findFirst({
          where: { id: params.id, userId },
          select: { id: true },
        });
        if (!definition) {
          throw new Error(`Agent job ${params.id} not found`);
        }

        const where: Record<string, unknown> = { definitionId: params.id, userId };
        if (params.status) {
          where.status = params.status;
        }

        const runs = await prisma.agentRun.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: params.limit ?? 10,
          select: {
            id: true,
            status: true,
            prompt: true,
            modelId: true,
            inputTokens: true,
            outputTokens: true,
            cost: true,
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
                prompt: string;
                modelId: string | null;
                inputTokens: number;
                outputTokens: number;
                cost: number;
                error: string | null;
                startedAt: Date | null;
                completedAt: Date | null;
                createdAt: Date;
              }) => ({
                id: r.id,
                status: r.status,
                prompt: r.prompt,
                modelId: r.modelId,
                inputTokens: r.inputTokens,
                outputTokens: r.outputTokens,
                cost: r.cost,
                error: r.error,
                ...(r.startedAt ? { startedAt: r.startedAt.toISOString() } : {}),
                ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
                duration:
                  r.startedAt && r.completedAt
                    ? r.completedAt.getTime() - r.startedAt.getTime()
                    : null,
                createdAt: r.createdAt.toISOString(),
              }),
            ),
          },
          details: { count: runs.length },
        };
      },
    }),

    // ─── agent_job_run_messages ─────────────────────────────────────────────

    defineStructuredTool({
      name: "agent_job_run_messages",
      label: "Agent Run Messages",
      description:
        "View the full conversation for a specific agent run, including tool calls, thinking, and responses.",
      parameters: Type.Object({
        runId: Type.String({
          description: "Run ID.",
        }),
      }),
      outputSchema: AGENT_RUN_MESSAGES_SCHEMA,
      execute: async (_toolCallId, params) => {
        const run = await prisma.agentRun.findFirst({
          where: { id: params.runId, userId },
          select: { id: true },
        });
        if (!run) {
          throw new Error(`Run ${params.runId} not found`);
        }

        const messages = await prisma.agentRunMessage.findMany({
          where: { runId: params.runId },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            content: true,
            thinking: true,
            toolCalls: true,
            createdAt: true,
          },
        });

        return {
          value: {
            runId: params.runId,
            count: messages.length,
            messages: messages.map(
              (m: {
                id: string;
                role: string;
                content: string;
                thinking: string | null;
                toolCalls: string | null;
                createdAt: Date;
              }) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                thinking: m.thinking,
                toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : null,
                createdAt: m.createdAt.toISOString(),
              }),
            ),
          },
          details: { count: messages.length },
        };
      },
    }),
  ];
}
