import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/lib/agent-jobs/executor";

/**
 * Create agent job tools with userId injection for user isolation.
 * Allows the agent to create, list, run, and inspect custom agent job definitions.
 */
export function createAgentJobTools(userId: string): ToolDefinition[] {
  return [
    // ─── agent_job_list ─────────────────────────────────────────────────────

    defineTool({
      name: "agent_job_list",
      label: "List Agent Jobs",
      description:
        "List all custom agent job definitions with their status, run count, and latest run.",
      parameters: Type.Object({
        enabled: Type.Optional(
          Type.Boolean({
            description: "Filter by enabled/disabled status.",
          }),
        ),
      }),
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
            enabled: true,
            runCount: { select: { runs: true } },
            createdAt: true,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: definitions.length,
                  jobs: definitions.map(
                    (d: {
                      id: string;
                      name: string;
                      description: string | null;
                      prompt: string;
                      systemPrompt: string | null;
                      toolConfig: unknown;
                      modelId: string | null;
                      enabled: boolean;
                      runCount: { runs: number };
                      createdAt: Date;
                    }) => ({
                      id: d.id,
                      name: d.name,
                      description: d.description,
                      prompt: d.prompt,
                      systemPrompt: d.systemPrompt,
                      toolConfig: d.toolConfig as Record<string, boolean> | null,
                      modelId: d.modelId,
                      enabled: d.enabled,
                      runCount: d.runCount.runs,
                      createdAt: d.createdAt.toISOString(),
                    }),
                  ),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: definitions.length },
        };
      },
    }),

    // ─── agent_job_create ───────────────────────────────────────────────────

    defineTool({
      name: "agent_job_create",
      label: "Create Agent Job",
      description:
        "Create a new custom agent job definition. Requires: name, prompt. Optional: description, systemPrompt, toolConfig, modelId.",
      parameters: Type.Object({
        name: Type.String({
          description: "Job name (max 100 chars).",
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
            },
            {
              description:
                "Which tool categories to expose. Available: email, calendar, jobs, chatSearch, web, memory, tasks.",
            },
          ),
        ),
        modelId: Type.Optional(
          Type.String({
            description: "Model override (format: 'provider:modelId').",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        // Normalize modelId
        const rawModelId = params.modelId || null;
        const resolvedModelId = rawModelId?.includes("/")
          ? rawModelId.replace("/", ":")
          : rawModelId;

        const definition = await prisma.agentDefinition.create({
          data: {
            userId,
            name: params.name.trim(),
            description: params.description?.trim() || null,
            prompt: params.prompt.trim(),
            systemPrompt: params.systemPrompt?.trim() || null,
            toolConfig: (params.toolConfig as Record<string, boolean>) ?? null,
            modelId: resolvedModelId,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  created: true,
                  job: {
                    id: definition.id,
                    name: definition.name,
                    description: definition.description,
                    prompt: definition.prompt,
                    systemPrompt: definition.systemPrompt,
                    toolConfig: definition.toolConfig as Record<string, boolean> | null,
                    modelId: definition.modelId,
                    enabled: definition.enabled,
                    createdAt: definition.createdAt.toISOString(),
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: { id: definition.id },
        };
      },
    }),

    // ─── agent_job_run ──────────────────────────────────────────────────────

    defineTool({
      name: "agent_job_run",
      label: "Run Agent Job",
      description: "Trigger an immediate run of a custom agent job by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Job definition ID.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const definition = await prisma.agentDefinition.findFirst({
          where: { id: params.id, userId },
        });
        if (!definition) {
          throw new Error(`Agent job ${params.id} not found`);
        }
        if (!definition.enabled) {
          throw new Error(`Agent job ${params.id} is disabled`);
        }

        const run = await prisma.agentRun.create({
          data: {
            definitionId: params.id,
            userId,
            status: "pending",
            prompt: definition.prompt,
            systemPrompt: definition.systemPrompt,
            modelId: definition.modelId,
          },
        });

        // Execute asynchronously
        executeAgentRun(
          run.id,
          {
            prompt: definition.prompt,
            systemPrompt: definition.systemPrompt,
            toolConfig: definition.toolConfig as Record<string, boolean> | null,
            modelId: definition.modelId,
            thinkingLevel: definition.thinkingLevel,
          },
          userId,
        )
          .then(async (stats) => {
            await prisma.agentRun.update({
              where: { id: run.id },
              data: {
                status: "completed",
                inputTokens: stats.inputTokens,
                outputTokens: stats.outputTokens,
                cost: stats.cost,
                startedAt: new Date(),
                completedAt: new Date(),
              },
            });
          })
          .catch(async (err) => {
            console.error(`[agent-job:${run.id}] Execution failed:`, err);
            await prisma.agentRun.update({
              where: { id: run.id },
              data: {
                status: "error",
                error: err.message,
                startedAt: new Date(),
                completedAt: new Date(),
              },
            });
          });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  queued: true,
                  runId: run.id,
                  jobId: params.id,
                },
                null,
                2,
              ),
            },
          ],
          details: { runId: run.id },
        };
      },
    }),

    // ─── agent_job_logs ─────────────────────────────────────────────────────

    defineTool({
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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
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
                      startedAt: r.startedAt?.toISOString(),
                      completedAt: r.completedAt?.toISOString(),
                      duration:
                        r.startedAt && r.completedAt
                          ? r.completedAt.getTime() - r.startedAt.getTime()
                          : null,
                      createdAt: r.createdAt.toISOString(),
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

    // ─── agent_job_run_messages ─────────────────────────────────────────────

    defineTool({
      name: "agent_job_run_messages",
      label: "Agent Run Messages",
      description:
        "View the full conversation for a specific agent run, including tool calls, thinking, and responses.",
      parameters: Type.Object({
        runId: Type.String({
          description: "Run ID.",
        }),
      }),
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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
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
                null,
                2,
              ),
            },
          ],
          details: { count: messages.length },
        };
      },
    }),
  ];
}
