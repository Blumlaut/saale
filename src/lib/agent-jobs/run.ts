import { prisma } from "@/lib/db";
import { executeAgentRun } from "@/lib/agent-jobs/executor";
import { buildAgentOutputHandler } from "@/lib/agent-jobs/output";

/**
 * Persist the run's delivery outcome, if there is anything to record.
 *
 * Two sources feed one column: the channel could not be resolved up front
 * (`preflightError`), or it resolved and then rejected the messages the run
 * produced (`runtimeErrors`). Both mean the same thing to a reader — the user
 * was never told — so they share `AgentRun.deliveryError`.
 *
 * A successful send clears nothing: an earlier failure stays on the record
 * even if a later turn got through, because the run still owes the user
 * something.
 */
async function recordDeliveryFailures(
  runId: string,
  runtimeErrors: string[] | undefined,
  preflightError: string | undefined,
): Promise<void> {
  const failures = [preflightError, ...(runtimeErrors ?? [])].filter(
    (entry): entry is string => !!entry,
  );
  if (failures.length === 0) return;

  await prisma.agentRun
    .update({
      where: { id: runId },
      data: { deliveryError: [...new Set(failures)].join("\n") },
    })
    .catch((err) => {
      console.error(`[agent-job:${runId}] Failed to record delivery error:`, err);
    });
}

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
 * @param modelId - Optional model override (defaults to definition.modelId)
 * @returns The created AgentRun record
 * @throws When the definition does not exist or is disabled
 */
export async function triggerAgentRun(params: {
  definitionId: string;
  userId: string;
  promptOverride?: string;
  modelId?: string;
}): Promise<{
  id: string;
  status: string;
  prompt: string;
  outputChannel: string | null;
  outputChannelId: string | null;
  createdAt: Date;
}> {
  const { definitionId, userId, promptOverride, modelId } = params;

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
  const runModelId = modelId ?? definition.modelId;

  const run = await prisma.agentRun.create({
    data: {
      definitionId,
      userId,
      status: "pending",
      prompt: runPrompt,
      systemPrompt: definition.systemPrompt,
      modelId: runModelId,
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
  const { output, error: deliveryError } = await buildAgentOutputHandler({
    userId,
    outputChannel: definition.outputChannel,
    outputChannelId: definition.outputChannelId,
  });

  // Mark the run as running — startedAt is when execution actually starts
  // (the run record was created above as "pending"). A channel that cannot be
  // resolved is recorded now, so the run never reads as delivered.
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "running", startedAt: new Date(), deliveryError: deliveryError ?? null },
  });

  // Execute asynchronously (fire-and-forget, but with error handling)
  executeAgentRun(
    run.id,
    {
      prompt: runPrompt,
      systemPrompt: definition.systemPrompt,
      toolConfig: definition.toolConfig as Record<string, boolean> | null,
      modelId: runModelId,
      thinkingLevel: definition.thinkingLevel,
    },
    userId,
    output,
  )
    .then(async (stats) => {
      // A run whose output channel rejected every message still "completed" —
      // the failure belongs on the record, or the job silently told nobody.
      await recordDeliveryFailures(run.id, output?.deliveryErrors?.(), deliveryError);
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
      await recordDeliveryFailures(run.id, output?.deliveryErrors?.(), deliveryError);
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
