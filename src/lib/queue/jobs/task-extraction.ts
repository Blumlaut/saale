import { extractTasksFromEmails } from "@/lib/tasks/task-extraction";
import { batchSizeField, emailAccountField, maxEmailAgeField, modelField } from "./_helpers";
import type { FieldDef } from "@/lib/queue/job-schemas";

export const metadata = {
  type: "task_extraction",
  label: "Email → Tasks",
  description: "Scan emails for action items and create tasks",
  icon: "CheckSquare",
  defaultCron: "0 */6 * * *",
  usesAi: true,
} as const;

export const fields: FieldDef[] = [
  emailAccountField("Email Account", "Leave empty to scan all enabled email accounts"),
  batchSizeField({
    description: "Number of emails to scan per run",
    fallback: 20,
    max: 100,
  }),
  maxEmailAgeField({ verb: "scan", fallback: 48 }),
  modelField("Model used for task extraction"),
];

export async function handler(params: {
  config: Record<string, unknown>;
  userId: string;
  modelId?: string | null;
}) {
  const { config, userId, modelId } = params;

  const result = await extractTasksFromEmails({
    userId,
    ...(config.accountId ? { accountId: config.accountId as string } : {}),
    limit: (config.limit as number) ?? 20,
    maxEmailAge: (config.maxEmailAge as number) ?? 48,
    ...(modelId ? { modelId } : {}),
  });

  return JSON.stringify(result);
}
