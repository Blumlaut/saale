import { extractTasksFromEmails } from "@/lib/tasks/task-extraction";

export const metadata = {
  type: "task_extraction",
  label: "Email → Tasks",
  description: "Scan emails for action items and create tasks",
  icon: "CheckSquare",
  defaultCron: "0 */6 * * *",
  usesAi: true,
} as const;

export const fields = [
  {
    key: "accountId",
    label: "Email Account",
    description: "Leave empty to scan all enabled email accounts",
    type: "select" as const,
    default: "",
    options: [] as Array<{ value: string; label: string }>,
  },
  {
    key: "limit",
    label: "Batch size",
    description: "Number of emails to scan per run",
    type: "number" as const,
    default: 20,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: "maxEmailAge",
    label: "Max email age",
    description: "Only scan emails received within this many hours (0 = no limit)",
    type: "number" as const,
    default: 48,
    min: 0,
    max: 720,
    step: 1,
  },
  {
    key: "modelId",
    label: "AI Model",
    description: "Model used for task extraction",
    type: "model" as const,
    default: "",
  },
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
