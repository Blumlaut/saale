import type { Job } from "bullmq";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { buildModelRuntime } from "@/lib/pi/models";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";
import { createSessionSettings } from "@/lib/pi/settings";
import { getQueue, addJobRun, updateJobRun, queueTaskSchedulerId } from "@/lib/queue";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { createAgentIdleTimeout } from "@/lib/pi/agent-idle-timeout";
import { handlerMap } from "./jobs/registry";

// ─── AI Dispatch ─────────────────────────────────────────────────────────────

/**
 * Dispatch a non-streaming AI job using the Pi agent.
 * Creates a one-shot session, sends a prompt, and waits for the response.
 *
 * @param userId - The user whose API keys and model registry to use
 * @param prompt - The prompt to send to the AI
 * @param systemPrompt - Optional system prompt (defaults to a job-oriented prompt)
 * @param modelId - Optional model override ("provider:modelName")
 * @returns The AI's text response
 */
export async function dispatchAiJob(
  userId: string,
  prompt: string,
  options?: {
    systemPrompt?: string;
    modelId?: string | null;
  },
): Promise<string> {
  const modelInfo = await resolveModelForPurpose(userId, "jobs", options?.modelId);

  // Build a minimal model runtime (no tools, no extensions — just the model)
  const { modelRuntime } = await buildModelRuntime(userId);

  let model;
  if (modelInfo) {
    model = modelRuntime.getModel(modelInfo.provider, modelInfo.name);
  }

  const systemPrompt =
    options?.systemPrompt ??
    `You are an AI assistant processing automated jobs. Respond with valid JSON only — no markdown, no explanation, just the raw JSON object.`;

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    settingsManager: createSessionSettings(),
    noTools: "all",
    ...(model ? { model } : {}),
    resourceLoader: await createSystemPromptLoader(systemPrompt, process.cwd()),
    thinkingLevel: "off",
  });

  return new Promise((resolve, reject) => {
    // Idle timeout — fires only if the session goes completely silent
    // (hung model, dead connection). Every agent event resets the window.
    const idleTimeout = createAgentIdleTimeout({
      session,
      timeoutMs: 5 * 60_000,
      label: `ai-job:${userId}`,
      onTimeout: () => {
        unsubscribe();
        session.abort().catch((err) => {
          console.error("[queue/ai-job] Failed to abort on timeout:", err);
        });
        reject(new Error("AI job stalled (no activity for 5min)"));
      },
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") {
        idleTimeout.clear();
        unsubscribe();
        const lastMsg = event.messages.findLast((m) => m.role === "assistant");
        const textBlocks = lastMsg?.content.filter(
          (c) => typeof c === "object" && c.type === "text",
        );
        const text =
          textBlocks
            ?.map((c) => (typeof c === "object" && "text" in c ? (c.text as string) : ""))
            .join("") ?? "";
        resolve(text);
      }
    });

    // Call agent.prompt directly to bypass AgentSession's preflight logic
    // which resets systemPrompt back to the Pi base prompt on every turn
    session.agent.prompt(prompt).catch((err) => {
      idleTimeout.clear();
      unsubscribe();
      reject(err);
    });
  });
}

// ─── Job Processing ──────────────────────────────────────────────────────────

/**
 * Process a single job execution.
 * This is the handler called by BullMQ workers.
 * Dispatches to the appropriate handler from the jobs/ registry.
 */
export async function processJob(job: Job): Promise<void> {
  const { taskId, runId, type, modelId, ...config } = job.data;

  // Resolve the user for this job
  const queueJob = await prisma.queueTask.findUnique({
    where: { id: taskId },
    select: { userId: true },
  });

  if (!queueJob) {
    // Job was deleted — remove the scheduler so it doesn't keep firing,
    // then skip silently instead of throwing (which would cause retries).
    if (!runId) {
      getQueue()
        .removeJobScheduler(queueTaskSchedulerId(taskId))
        .catch((err) => {
          console.error(`[queue/job-handler] Failed to remove scheduler for ${taskId}:`, err);
        });
    }
    console.warn(`[queue/job-handler] Job ${taskId} not found, skipping.`);
    return;
  }

  // Look up handler from registry
  const handlerModule = handlerMap.get(type);
  if (!handlerModule) {
    throw new Error(`Unknown job type: ${type}`);
  }

  // Create a run record for scheduled jobs (no runId), or use existing for manual runs
  const run = runId
    ? null
    : await addJobRun(taskId, "pending", JSON.stringify({ type, modelId, ...config }));

  const effectiveRunId = runId ?? run?.id;

  // Mark run as running
  if (effectiveRunId) {
    await updateJobRun(effectiveRunId, { status: "running", startedAt: new Date() });
  }

  try {
    const output = await handlerModule.handler({
      config,
      userId: queueJob.userId,
      modelId,
    });

    // Mark as completed
    if (effectiveRunId) {
      await updateJobRun(effectiveRunId, { status: "completed", output, completedAt: new Date() });
    }

    // Update job metadata
    await prisma.queueTask.update({
      where: { id: taskId },
      data: {
        lastRunAt: new Date(),
        runCount: { increment: 1 },
      },
    });
  } catch (err) {
    const errorMessage = (err as Error).message;

    if (effectiveRunId) {
      await updateJobRun(effectiveRunId, {
        status: "error",
        error: errorMessage,
        completedAt: new Date(),
      });
    }

    throw err;
  }
}
