import { prisma } from "@/lib/db";
import { dispatchAiJob } from "@/lib/queue/job-handler";

export interface ExtractedTask {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  dueDate?: string; // ISO date string
  tags?: string[];
}

/**
 * System prompt for task extraction from emails.
 */
const EXTRACT_TASKS_PROMPT = `You are a task extraction assistant. Analyze the given email and determine if it contains action items, to-dos, or follow-up tasks.

If the email contains tasks, extract them in JSON format. Be conservative — only extract when you're confident about an action item.

Rules:
- The title should be a concise action (e.g. "Review Q3 budget", "Reply to client about deadline")
- The dueDate must be a valid ISO date (YYYY-MM-DD). Use the current date as reference for relative dates ("next Tuesday", "tomorrow").
- Priority: "high" for urgent/ASAP items, "medium" for normal follow-ups, "low" for nice-to-have tasks.
- Skip generic newsletters, promotional emails, or emails without clear action items.
- Extract at most 3 tasks per email.
- Tags should be relevant keywords from the email (e.g. "work", "finance", "client-name").

Current date: {{CURRENT_DATE}}

Respond with a JSON array of tasks. If no tasks are found, respond with an empty array [].`;

/**
 * Scan emails for action items and create tasks.
 *
 * @param params Configuration for the extraction job
 * @returns Summary of the extraction run
 */
export async function extractTasksFromEmails(params: {
  userId: string;
  accountId?: string; // Email account ID (empty = all accounts)
  limit?: number; // Max emails to scan
  maxEmailAge?: number; // Max age in hours (0 = no limit)
  modelId?: string | null; // AI model override
}): Promise<{
  emailsScanned: number;
  tasksCreated: number;
  tasksSkipped: number;
  errors: string[];
}> {
  let emailsScanned = 0;
  let tasksCreated = 0;
  let tasksSkipped = 0;
  const errors: string[] = [];

  // Fetch candidate emails
  const where: Record<string, unknown> = {
    taskScanned: false,
  };

  if (params.accountId) {
    where.accountId = params.accountId;
  }

  if (params.maxEmailAge && params.maxEmailAge > 0) {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - params.maxEmailAge);
    where.date = { gte: cutoff };
  }

  const limit = Math.min(params.limit ?? 20, 100);
  const emails = await prisma.emailMessage.findMany({
    where,
    orderBy: { date: "desc" },
    take: limit,
    select: {
      id: true,
      subject: true,
      bodyText: true,
      bodyPreview: true,
      date: true,
      accountId: true,
    },
  });

  for (const email of emails) {
    emailsScanned++;

    try {
      // Mark as scanned immediately to avoid re-processing on retry
      await prisma.emailMessage.update({
        where: { id: email.id },
        data: { taskScanned: true },
      });

      const extracted = await extractSingleEmail(email, params.userId, params.modelId);

      if (!extracted || extracted.length === 0) {
        tasksSkipped++;
        continue;
      }

      for (const taskData of extracted) {
        try {
          // Validate
          if (!taskData.title) continue;

          // Dedup check (scoped to user)
          const isDuplicate = await checkDuplicate(taskData, params.userId);
          if (isDuplicate) {
            tasksSkipped++;
            continue;
          }

          // Create task
          await createTask(taskData, params.userId, email.id);
          tasksCreated++;
        } catch (err) {
          const taskErr = err as Error;
          console.error(
            `[task-extraction] Failed to create task from email ${email.id}:`,
            taskErr.message,
          );
          errors.push(
            `Failed to create task "${taskData.title?.slice(0, 50)}": ${taskErr.message}`,
          );
        }
      }
    } catch (err) {
      const emailErr = err as Error;
      console.error(`[task-extraction] Failed to process email ${email.id}:`, emailErr.message);
      errors.push(`Failed to process email "${email.subject.slice(0, 50)}": ${emailErr.message}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[task-extraction] Done: ${emailsScanned} scanned, ${tasksCreated} created, ` +
      `${tasksSkipped} skipped, ${errors.length} errors`,
  );

  return { emailsScanned, tasksCreated, tasksSkipped, errors };
}

/**
 * Extract task data from a single email using AI.
 */
async function extractSingleEmail(
  email: {
    subject: string;
    bodyText: string | null;
    bodyPreview: string | null;
    date: Date;
  },
  userId: string,
  modelId?: string | null,
): Promise<ExtractedTask[]> {
  const body = email.bodyText ?? email.bodyPreview ?? "";
  const currentDate = new Date().toISOString().split("T")[0] ?? "";

  const systemPrompt = EXTRACT_TASKS_PROMPT.replace("{{CURRENT_DATE}}", currentDate);

  const prompt = JSON.stringify({
    task: "extract_tasks",
    instructions: systemPrompt,
    email: {
      subject: email.subject,
      body: body.slice(0, 4000),
    },
  });

  const response = await dispatchAiJob(userId, prompt, {
    modelId: modelId ?? null,
  });
  const text = response.trim();

  if (!text || text === "[]" || text === "null" || text === "NULL") {
    return [];
  }

  // Parse JSON response
  try {
    // Handle markdown code blocks
    const cleaned = text.replace(/```(?:json)?\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as ExtractedTask[];

    if (!Array.isArray(parsed)) return [];

    return parsed.filter((t) => t && t.title);
  } catch {
    console.warn(`[task-extraction] Failed to parse AI response:`, text.slice(0, 200));
    return [];
  }
}

/**
 * Check if a task with a similar title already exists.
 * Uses DB-level case-insensitive substring matching (scoped to the user's pending tasks).
 */
async function checkDuplicate(task: ExtractedTask, userId: string): Promise<boolean> {
  const existing = await prisma.task.findMany({
    where: {
      userId,
      status: "pending",
      title: { contains: task.title, mode: "insensitive" },
    },
    take: 5,
    select: { id: true, title: true },
  });

  return existing.length > 0;
}

/**
 * Create a task from extracted data.
 * Scoped to the user's own tasks.
 */
async function createTask(
  task: ExtractedTask,
  userId: string,
  sourceEmailId?: string,
): Promise<void> {
  await prisma.task.create({
    data: {
      userId,
      title: task.title,
      description: task.description ?? null,
      priority: task.priority ?? "medium",
      dueDate: task.dueDate ? new Date(task.dueDate) : null,
      tags: task.tags ?? [],
      source: "email_extraction",
      sourceEmailId: sourceEmailId ?? null,
    },
  });
}
