import type { Job } from "bullmq";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { buildModelRegistry } from "@/lib/pi/models";
import { addJobRun, updateJobRun } from "@/lib/queue";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { handlerMap } from "./jobs/registry";

// ─── AI Dispatch ─────────────────────────────────────────────────────────────

/**
 * Dispatch a non-streaming AI task using the Pi agent.
 * Creates a one-shot session, sends a prompt, and waits for the response.
 *
 * @param userId - The user whose API keys and model registry to use
 * @param prompt - The prompt to send to the AI
 * @param systemPrompt - Optional system prompt (defaults to a task-oriented prompt)
 * @param modelId - Optional model override ("provider:modelName")
 * @returns The AI's text response
 */
export async function dispatchAiTask(
  userId: string,
  prompt: string,
  options?: {
    systemPrompt?: string;
    modelId?: string | null;
  },
): Promise<string> {
  const modelInfo = await resolveModelForPurpose(userId, "tasks", options?.modelId);

  // Build a minimal model registry (no tools, no extensions — just the model)
  const { modelRegistry, authStorage } = await buildModelRegistry(userId);

  let model;
  if (modelInfo) {
    model = modelRegistry.find(modelInfo.provider, modelInfo.name);
  }

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    noTools: "all",
    ...(model ? { model } : {}),
    thinkingLevel: "off",
  });

  session.agent.state.systemPrompt =
    options?.systemPrompt ??
    `You are an AI assistant processing automated tasks. Respond with valid JSON only — no markdown, no explanation, just the raw JSON object.`;

  let timerId: ReturnType<typeof setTimeout>;

  return new Promise((resolve, reject) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") {
        clearTimeout(timerId);
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

    // Timeout after 5min
    timerId = setTimeout(() => {
      unsubscribe();
      reject(new Error("AI task timed out (5min)"));
    }, 5 * 60_000);

    // Call agent.prompt directly to bypass AgentSession's preflight logic
    // which resets systemPrompt back to the Pi base prompt on every turn
    session.agent.prompt(prompt);
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

  // Resolve the user for this task
  const task = await prisma.queueTask.findUnique({
    where: { id: taskId },
    select: { userId: true },
  });

  if (!task) {
    throw new Error(`Task ${taskId} not found`);
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
      userId: task.userId,
      modelId,
    });

    // Mark as completed
    if (effectiveRunId) {
      await updateJobRun(effectiveRunId, { status: "completed", output, completedAt: new Date() });
    }

    // Update task metadata
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
