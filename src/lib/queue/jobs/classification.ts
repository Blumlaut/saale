import { prisma } from "@/lib/db";
import { dispatchAiTask } from "@/lib/queue/job-handler";
import { resolveUserEmailAccountIds } from "@/lib/queue/user-isolation";

export const metadata = {
  type: "classification",
  label: "Classification + Tags",
  description: "Auto-tag incoming emails with AI categories",
  icon: "Tags",
  defaultCron: "0 */6 * * *",
  usesAi: true,
} as const;

export const fields = [
  {
    key: "accountId",
    label: "Account",
    description: "Leave empty to process all accounts",
    type: "select" as const,
    default: "",
    options: [] as Array<{ value: string; label: string }>,
  },
  {
    key: "limit",
    label: "Batch size",
    description: "Number of emails to process per run",
    type: "number" as const,
    default: 10,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: "maxEmailAge",
    label: "Max email age",
    description: "Only process emails received within this many hours (0 = no limit)",
    type: "number" as const,
    default: 24,
    min: 0,
    max: 720,
    step: 1,
  },
  {
    key: "modelId",
    label: "AI Model",
    description: "Override the default model for this task",
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
  const accountIds = await resolveUserEmailAccountIds(
    userId,
    config.accountId as string | undefined,
  );

  const whereClause: Record<string, unknown> = {
    accountId: { in: accountIds },
    ...(config.accountId ? { accountId: config.accountId } : {}),
    classified: false,
  };
  if (config.maxEmailAge && (config.maxEmailAge as number) > 0) {
    whereClause.date = {
      gte: new Date(Date.now() - (config.maxEmailAge as number) * 60 * 60 * 1000),
    };
  }
  const emails = await prisma.emailMessage.findMany({
    where: whereClause,
    orderBy: { date: "desc" },
    take: (config.limit as number) ?? 10,
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
    return JSON.stringify({ processed: 0, classifications: [] });
  }

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

  const response = await dispatchAiTask(userId, prompt, ...(modelId ? [{ modelId }] : []));

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

  // Guard: only update emails from the scanned batch (defense against AI hallucination)
  const scannedIds = new Set(emails.map((e) => e.id));
  for (const classification of classifications) {
    if (!scannedIds.has(classification.id)) continue;
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
        classified: true,
      },
    });
  }

  return JSON.stringify({
    processed: emails.length,
    classified: classifications.length,
    classifications,
  });
}
