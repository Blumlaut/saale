import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/lib/agent-jobs/executor";
import { buildAgentOutputHandler } from "@/lib/agent-jobs/output";

/**
 * Create a run record for an agent definition and execute it asynchronously.
 *
 * Shared by the manual trigger endpoints (UI + LLM tools) and the scheduled
 * execution path (BullMQ worker → internal API). The agent execution itself
 * is fire-and-forget (matching the existing manual-run behavior): this
 * function returns as soon as the run record is persisted, while the run's
 * status is tracked in the database as execution proceeds.
 *
 * @param definitionId - The AgentDefinition.id to run
 * @param userId - The user who owns the definition (scopes the lookup)
 * @param promptOverride - Optional prompt override (defaults to definition.prompt)
 * @returns The created AgentRun record
 * @throws When the definition does not exist or is disabled
 */
export async function triggerAgentRun(params: {
  definitionId: string;
  userId: string;
  promptOverride?: string;
}): Promise<{
  id: string;
  status: string;
  prompt: string;
  outputChannel: string | null;
  outputChannelId: string | null;
  createdAt: Date;
}> {
  const { definitionId, userId, promptOverride } = params;

  const definition = await prisma.agentDefinition.findFirst({
    where: { id: definitionId, userId },
  });
  if (!definition) {
    throw new Error(`Agent job ${definitionId} not found`);
  }
  if (!definition.enabled) {
    throw new Error(`Agent job ${definitionId} is disabled`);
  }

  const runPrompt = promptOverride || definition.prompt;

  const run = await prisma.agentRun.create({
    data: {
      definitionId,
      userId,
      status: "pending",
      prompt: runPrompt,
      systemPrompt: definition.systemPrompt,
      modelId: definition.modelId,
      outputChannel: definition.outputChannel,
      outputChannelId: definition.outputChannelId,
    },
  });

  // Update lastRunAt on the definition
  await prisma.agentDefinition.update({
    where: { id: definitionId },
    data: { lastRunAt: new Date() },
  });

  // Resolve the external output handler (e.g., Telegram) before dispatching.
  // executeAgentRun only routes output when a handler is provided.
  const output = await buildAgentOutputHandler({
    userId,
    outputChannel: definition.outputChannel,
    outputChannelId: definition.outputChannelId,
  });

  // Mark the run as running — startedAt is when execution actually starts
  // (the run record was created above as "pending").
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "running", startedAt: new Date() },
  });

  // Execute asynchronously (fire-and-forget, but with error handling)
  executeAgentRun(
    run.id,
    {
      prompt: runPrompt,
      systemPrompt: definition.systemPrompt,
      toolConfig: definition.toolConfig as Record<string, boolean> | null,
      modelId: definition.modelId,
      thinkingLevel: definition.thinkingLevel,
    },
    userId,
    output,
  )
    .then(async (stats) => {
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
          cost: stats.cost,
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
          completedAt: new Date(),
        },
      });
    });

  return {
    id: run.id,
    status: run.status,
    prompt: runPrompt,
    outputChannel: run.outputChannel,
    outputChannelId: run.outputChannelId,
    createdAt: run.createdAt,
  };
}
