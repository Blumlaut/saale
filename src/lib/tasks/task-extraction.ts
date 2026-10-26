import { prisma } from "@/lib/db";
import { askForJson, scanUnreadEmails } from "@/lib/email/extraction-scan";
import { findDuplicateTasks } from "@/lib/tasks/task-api-helpers";

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

If the email contains tasks, extract them in JSON format. Be conservative. only extract when you're confident about an action item.

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
  const scan = await scanUnreadEmails({
    tag: "task-extraction",
    scannedFlag: "taskScanned",
    userId: params.userId,
    accountId: params.accountId,
    limit: params.limit,
    maxEmailAge: params.maxEmailAge,
    process: async (email) => {
      const extracted = await extractSingleEmail(email, params.userId, params.modelId);
      if (!extracted || extracted.length === 0) return { skipped: 1 };

      let created = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const taskData of extracted) {
        try {
          if (!taskData.title) {
            skipped++;
            continue;
          }

          const duplicates = await findDuplicateTasks(taskData.title, params.userId);
          if (duplicates.length > 0) {
            skipped++;
            continue;
          }

          await createTask(taskData, params.userId, email.id);
          created++;
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

      return { created, skipped, errors };
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `[task-extraction] Done: ${scan.emailsScanned} scanned, ${scan.created} created, ` +
      `${scan.skipped} skipped, ${scan.errors.length} errors`,
  );

  return {
    emailsScanned: scan.emailsScanned,
    tasksCreated: scan.created,
    tasksSkipped: scan.skipped,
    errors: scan.errors,
  };
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

  const prompt = {
    task: "extract_tasks",
    instructions: systemPrompt,
    email: {
      subject: email.subject,
      body: body.slice(0, 4000),
    },
  };

  const parsed = await askForJson<ExtractedTask[]>(userId, prompt, {
    modelId,
    tag: "task-extraction",
  });

  if (!Array.isArray(parsed)) return [];

  return parsed.filter((t) => t && t.title);
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
