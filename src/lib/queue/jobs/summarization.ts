import { prisma } from "@/lib/db";
import { batchSizeField, emailAccountField, maxEmailAgeField, modelField } from "./_helpers";
import type { FieldDef } from "@/lib/queue/job-schemas";
import { dispatchAiJob } from "@/lib/queue/job-handler";
import { resolveUserEmailAccountIds } from "@/lib/queue/user-isolation";

export const metadata = {
  type: "summarization",
  label: "Email Summarization",
  description: "Generate AI summaries for new emails",
  icon: "FileText",
  defaultCron: "0 */6 * * *",
  usesAi: true,
} as const;

export const fields: FieldDef[] = [
  emailAccountField(),
  batchSizeField({
    description: "Number of emails to process per run",
    fallback: 10,
    max: 100,
  }),
  maxEmailAgeField({ verb: "process", fallback: 24 }),
  modelField(),
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
    aiSummary: null,
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
      date: true,
    },
  });

  if (emails.length === 0) {
    return JSON.stringify({ processed: 0, summaries: [] });
  }

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

  const response = await dispatchAiJob(userId, prompt, ...(modelId ? [{ modelId }] : []));

  let parsed;
  try {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, response];
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch {
    parsed = { summaries: [] };
  }

  const summaries = (parsed.summaries ?? []).filter(
    (s: { id: string; summary: string }) => s.id && s.summary,
  );

  // Guard: only update emails from the scanned batch (defense against AI hallucination)
  const scannedIds = new Set(emails.map((e) => e.id));
  for (const summary of summaries) {
    if (!scannedIds.has(summary.id)) continue;
    await prisma.emailMessage.update({
      where: { id: summary.id },
      data: { aiSummary: summary.summary },
    });
  }

  return JSON.stringify({
    processed: emails.length,
    summarized: summaries.length,
    summaries,
  });
}
