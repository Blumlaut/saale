import { Queue, Worker, type Job } from "bullmq";
import { prisma } from "@/lib/db";
import { syncEmailAccount } from "@/lib/email/sync";
import { createPiSession } from "@/lib/pi/session";

// ─── Connection ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

/**
 * Get a BullMQ connection (uses Redis URL string to avoid ioredis version conflicts).
 */
export function getConnection(): string {
  return REDIS_URL;
}

// ─── Shared Queue ────────────────────────────────────────────────────────────

const QUEUE_NAME = "saale-tasks";
let _queue: Queue | null = null;

/**
 * Get the shared BullMQ queue (singleton to avoid connection leaks).
 * All tasks share one queue; jobs are differentiated by taskId in job data.
 */
export function getQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: { url: getConnection() },
    });
  }
  return _queue;
}

// ─── Job Run Tracking ────────────────────────────────────────────────────────

export async function addJobRun(
  taskId: string,
  status: "pending" | "running" | "completed" | "error",
  input?: string,
): Promise<{ id: string }> {
  const run = await prisma.taskRun.create({
    data: {
      taskId,
      status,
      ...(input ? { input } : {}),
      startedAt: status === "running" ? new Date() : null,
      completedAt: status === "completed" || status === "error" ? new Date() : null,
    },
  });
  return { id: run.id };
}

export async function updateJobRun(
  runId: string,
  data: {
    status?: "pending" | "running" | "completed" | "error";
    output?: string;
    error?: string;
    startedAt?: Date;
    completedAt?: Date;
  },
): Promise<void> {
  await prisma.taskRun.update({
    where: { id: runId },
    data,
  });
}

// ─── Model Resolution ────────────────────────────────────────────────────────

/**
 * Resolve a modelId string ("provider:modelName") to { provider, name }.
 * Falls back to user settings if no modelId is set.
 * Returns undefined if no model can be resolved (caller should handle gracefully).
 */
export async function resolveModel(
  userId: string,
  modelId?: string | null,
): Promise<{ provider: string; name: string } | undefined> {
  // Job-level override takes priority
  if (modelId && modelId.includes(":")) {
    const [provider, ...nameParts] = modelId.split(":");
    if (!provider) return undefined;
    return { provider, name: nameParts.join(":") };
  }

  // Fall back to user settings
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultModelProvider: true, defaultModelName: true },
  });

  if (settings?.defaultModelProvider && settings?.defaultModelName) {
    return {
      provider: settings.defaultModelProvider,
      name: settings.defaultModelName,
    };
  }

  return undefined;
}

// ─── AI Dispatch ─────────────────────────────────────────────────────────────

/**
 * Dispatch a non-streaming AI task using the Pi agent.
 * Creates a one-shot session, sends a prompt, and waits for the response.
 *
 * @param userId - The user whose API keys and model registry to use
 * @param prompt - The prompt to send to the AI
 * @param systemPrompt - Optional system prompt (defaults to a task-oriented prompt)
 * @param modelId - Optional model override ("provider:modelName"), resolved via resolveModel()
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
  const modelInfo = await resolveModel(userId, options?.modelId);

  // Create session first to get the model registry for validation
  const sessionResult = await createPiSession({
    userId,
    customTools: [],
    ...(modelInfo ? { modelProvider: modelInfo.provider, modelName: modelInfo.name } : {}),
    thinkingLevel: "off",
  });

  const piSession = sessionResult.session;

  piSession.agent.state.systemPrompt =
    options?.systemPrompt ??
    `You are an AI assistant processing automated tasks. Respond with valid JSON only — no markdown, no explanation, just the raw JSON object.`;

  let timerId: ReturnType<typeof setTimeout>;

  return new Promise((resolve, reject) => {
    const unsubscribe = piSession.subscribe((event) => {
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

    // Timeout after 60s
    timerId = setTimeout(() => {
      unsubscribe();
      reject(new Error("AI task timed out (60s)"));
    }, 60_000);

    piSession.prompt(prompt);
  });
}

// ─── Worker ──────────────────────────────────────────────────────────────────

/**
 * Process a single job execution.
 * This is the handler called by BullMQ workers.
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
    let output: string;

    if (type === "email_sync") {
      // Sync specific account or all enabled accounts if no accountId given
      if (config.accountId) {
        const result = await syncEmailAccount(config.accountId);
        output = JSON.stringify(result);
      } else {
        const accounts = await prisma.emailAccount.findMany({
          where: { enabled: true },
          select: { id: true },
        });
        const results = await Promise.all(accounts.map((a) => syncEmailAccount(a.id)));
        output = JSON.stringify({
          accounts: results.length,
          results,
        });
      }
    } else if (type === "summarization") {
      const emails = await prisma.emailMessage.findMany({
        where: {
          ...(config.accountId ? { accountId: config.accountId } : {}),
          aiSummary: null,
        },
        orderBy: { date: "desc" },
        take: config.limit ?? 10,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          bodyText: true,
          date: true,
        },
      });

      if (emails.length === 0) {
        output = JSON.stringify({ processed: 0, summaries: [] });
      } else {
        const prompt = JSON.stringify({
          task: "summarize",
          instructions:
            "For each email, write a concise 1-2 sentence summary capturing the key point or action needed. Return a JSON object with a 'summaries' array where each item has 'id' and 'summary'.",
          emails: emails.map((e) => ({
            id: e.id,
            from: e.fromEmail,
            subject: e.subject,
            preview: (e.bodyText ?? e.bodyPreview)?.slice(0, 3000),
          })),
        });

        const response = await dispatchAiTask(task.userId, prompt, { modelId });

        let parsed;
        try {
          // Extract JSON from response (handle markdown code blocks)
          const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
          parsed = JSON.parse(jsonMatch[1].trim());
        } catch {
          parsed = { summaries: [] };
        }

        const summaries = (parsed.summaries ?? []).filter(
          (s: { id: string; summary: string }) => s.id && s.summary,
        );

        for (const summary of summaries) {
          await prisma.emailMessage.update({
            where: { id: summary.id },
            data: { aiSummary: summary.summary },
          });
        }

        output = JSON.stringify({
          processed: emails.length,
          summarized: summaries.length,
          summaries,
        });
      }
    } else if (type === "classification") {
      const emails = await prisma.emailMessage.findMany({
        where: {
          ...(config.accountId ? { accountId: config.accountId } : {}),
          aiTags: { isEmpty: true },
        },
        orderBy: { date: "desc" },
        take: config.limit ?? 10,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          bodyText: true,
          tags: true,
        },
      });

      if (emails.length === 0) {
        output = JSON.stringify({ processed: 0, classifications: [] });
      } else {
        const prompt = JSON.stringify({
          task: "classify",
          instructions:
            "For each email, assign relevant category tags from this list: finance, schedule, newsletter, security, social, work, personal, shopping, travel, health, news, promotion, notification. Return a JSON object with a 'classifications' array where each item has 'id' and 'tags' (array of strings).",
          emails: emails.map((e) => ({
            id: e.id,
            from: e.fromEmail,
            subject: e.subject,
            preview: (e.bodyText ?? e.bodyPreview)?.slice(0, 3000),
          })),
        });

        const response = await dispatchAiTask(task.userId, prompt, { modelId });

        let parsed;
        try {
          const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
          parsed = JSON.parse(jsonMatch[1].trim());
        } catch {
          parsed = { classifications: [] };
        }

        const classifications = (parsed.classifications ?? []).filter(
          (c: { id: string; tags: string[] }) => c.id && Array.isArray(c.tags),
        );

        for (const classification of classifications) {
          const newTags = Array.from(
            new Set([
              ...(emails.find((e) => e.id === classification.id)?.tags ?? []),
              ...classification.tags,
            ]),
          );
          await prisma.emailMessage.update({
            where: { id: classification.id },
            data: {
              tags: newTags,
              aiTags: classification.tags,
            },
          });
        }

        output = JSON.stringify({
          processed: emails.length,
          classified: classifications.length,
          classifications,
        });
      }
    } else if (type === "spam_filtering") {
      const emails = await prisma.emailMessage.findMany({
        where: {
          ...(config.accountId ? { accountId: config.accountId } : {}),
          folder: "INBOX",
          spamScore: null,
        },
        orderBy: { date: "desc" },
        take: config.limit ?? 20,
        select: {
          id: true,
          subject: true,
          fromEmail: true,
          bodyPreview: true,
          bodyText: true,
        },
      });

      if (emails.length === 0) {
        output = JSON.stringify({ processed: 0, results: [] });
      } else {
        const prompt = JSON.stringify({
          task: "spam_analysis",
          instructions:
            "For each email, evaluate whether it is likely spam. Return a JSON object with a 'results' array where each item has 'id', 'spamScore' (0-1 float, higher = more likely spam), and 'reason' (brief explanation).",
          emails: emails.map((e) => ({
            id: e.id,
            from: e.fromEmail,
            subject: e.subject,
            preview: (e.bodyText ?? e.bodyPreview)?.slice(0, 3000),
          })),
        });

        const response = await dispatchAiTask(task.userId, prompt, { modelId });

        let parsed;
        try {
          const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
          parsed = JSON.parse(jsonMatch[1].trim());
        } catch {
          parsed = { results: [] };
        }

        const spamResults = (parsed.results ?? []).filter(
          (r: { id: string; spamScore: number }) => r.id && typeof r.spamScore === "number",
        );

        for (const result of spamResults) {
          const shouldMove = result.spamScore > (config.spamThreshold ?? 0.85);
          await prisma.emailMessage.update({
            where: { id: result.id },
            data: {
              spamScore: Math.min(Math.max(result.spamScore, 0), 1),
              ...(shouldMove ? { folder: "Spam" } : {}),
            },
          });
        }

        output = JSON.stringify({
          processed: emails.length,
          analyzed: spamResults.length,
          movedToSpam: spamResults.filter(
            (r: { spamScore: number }) => r.spamScore > (config.spamThreshold ?? 0.85),
          ).length,
          results: spamResults,
        });
      }
    } else {
      throw new Error(`Unknown job type: ${type}`);
    }

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

// ─── Worker creation ─────────────────────────────────────────────────────────

/**
 * Create a BullMQ worker for the shared task queue.
 */
export function createWorker(concurrency = 5): Worker {
  return new Worker(QUEUE_NAME, processJob, {
    connection: { url: getConnection() },
    concurrency,
    limiter: {
      max: 10,
      duration: 60000,
    },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });
}

// ─── Schedule jobs from DB ──────────────────────────────────────────────────

/**
 * Schedule all enabled jobs from the database into BullMQ.
 * Call this on server startup.
 */
export async function scheduleAllJobs(): Promise<void> {
  const tasks = await prisma.queueTask.findMany({
    where: { enabled: true },
    select: {
      id: true,
      type: true,
      modelId: true,
      config: true,
    },
  });

  const queue = getQueue();
  for (const task of tasks) {
    const config = JSON.parse(task.config);

    if (config.cronExpression) {
      try {
        await queue.add(
          "execute",
          { ...config, taskId: task.id, type: task.type, modelId: task.modelId },
          {
            jobId: `scheduled-${task.id}`,
            repeat: { pattern: config.cronExpression, tz: "UTC" },
          },
        );
      } catch (err) {
        console.error(`Failed to schedule job ${task.id}: ${(err as Error).message}`);
      }
    }
  }
}
