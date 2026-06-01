import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { getQueue, addJobRun } from "@/lib/queue";

// ─── job_list ────────────────────────────────────────────────────────────────

export const jobListTool = defineTool({
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
        description: "Filter by job type (e.g. 'summarization', 'classification', 'spam_filtering').",
      }),
    ),
  }),
  execute: async (_toolCallId, params) => {
    const where: Record<string, unknown> = {};
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
              jobs: jobs.map((j: { id: string; type: string; enabled: boolean; config: string; lastRunAt: Date | null; runCount: number; createdAt: Date }) => ({
                id: j.id,
                type: j.type,
                enabled: j.enabled,
                config: JSON.parse(j.config),
                lastRunAt: j.lastRunAt?.toISOString(),
                runCount: j.runCount,
                createdAt: j.createdAt.toISOString(),
              })),
            },
            null,
            2,
          ),
        },
      ],
      details: { count: jobs.length },
    };
  },
});

// ─── job_enable ──────────────────────────────────────────────────────────────

export const jobEnableTool = defineTool({
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
  execute: async (_toolCallId, params) => {
    const job = await prisma.queueTask.findUnique({
      where: { id: params.id },
    });

    if (!job) {
      throw new Error(`Job ${params.id} not found`);
    }

    await prisma.queueTask.update({
      where: { id: params.id },
      data: { enabled: params.enabled },
    });

    // Update BullMQ schedule
    const queue = getQueue(params.id);
    if (params.enabled) {
      const config = JSON.parse(job.config);
      if (config.cronExpression) {
        await queue.add(
          "execute",
          { ...config, taskId: params.id },
          {
            jobId: params.id,
            repeat: { pattern: config.cronExpression, tz: "UTC" },
          },
        );
      }
    } else {
      await queue.obliterate({ force: true }).catch(() => {});
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
});

// ─── job_run ─────────────────────────────────────────────────────────────────

export const jobRunTool = defineTool({
  name: "job_run",
  label: "Run Job Now",
  description: "Trigger an immediate manual run of a job by its ID.",
  parameters: Type.Object({
    id: Type.String({
      description: "Job ID to run.",
    }),
  }),
  execute: async (_toolCallId, params) => {
    const job = await prisma.queueTask.findUnique({
      where: { id: params.id },
    });

    if (!job) {
      throw new Error(`Job ${params.id} not found`);
    }

    const queue = getQueue(params.id);
    const config = JSON.parse(job.config);

    const jobRun = await addJobRun(params.id, "pending", JSON.stringify(config));

    await queue.add(
      "execute",
      { ...config, taskId: params.id, runId: jobRun.id },
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
});

// ─── job_logs ────────────────────────────────────────────────────────────────

export const jobLogsTool = defineTool({
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
  execute: async (_toolCallId, params) => {
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
              runs: runs.map((r: { id: string; status: string; input: string | null; output: string | null; error: string | null; startedAt: Date | null; completedAt: Date | null }) => ({
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
              })),
            },
            null,
            2,
          ),
        },
      ],
      details: { count: runs.length },
    };
  },
});

// ─── Export all job tools ────────────────────────────────────────────────────

export const jobTools = [jobListTool, jobEnableTool, jobRunTool, jobLogsTool];
