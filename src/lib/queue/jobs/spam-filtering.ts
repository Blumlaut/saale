import { prisma } from "@/lib/db";
import { moveMessage } from "@/lib/email/imap";
import { dispatchAiTask } from "@/lib/queue/job-handler";
import { resolveUserEmailAccountIds } from "@/lib/queue/user-isolation";

export const metadata = {
  type: "spam_filtering",
  label: "Spam Filtering",
  description: "Evaluate spam score and move flagged emails",
  icon: "Shield",
  defaultCron: "0 */4 * * *",
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
    description: "Number of emails to scan per run",
    type: "number" as const,
    default: 20,
    min: 1,
    max: 200,
    step: 1,
  },
  {
    key: "spamThreshold",
    label: "Spam threshold",
    description: "Score above which emails are moved to Spam (0–1)",
    type: "number" as const,
    default: 0.85,
    min: 0,
    max: 1,
    step: 0.05,
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
  const spamThreshold = (config.spamThreshold as number) ?? 0.85;
  const accountIds = await resolveUserEmailAccountIds(
    userId,
    config.accountId as string | undefined,
  );

  const whereClause: Record<string, unknown> = {
    accountId: { in: accountIds },
    ...(config.accountId ? { accountId: config.accountId } : {}),
    folder: "INBOX",
    spamScore: null,
  };
  if (config.maxEmailAge && (config.maxEmailAge as number) > 0) {
    whereClause.date = {
      gte: new Date(Date.now() - (config.maxEmailAge as number) * 60 * 60 * 1000),
    };
  }
  const emails = await prisma.emailMessage.findMany({
    where: whereClause,
    orderBy: { date: "desc" },
    take: (config.limit as number) ?? 20,
    select: {
      id: true,
      subject: true,
      fromEmail: true,
      bodyPreview: true,
      bodyText: true,
    },
  });

  if (emails.length === 0) {
    return JSON.stringify({ processed: 0, results: [] });
  }

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

  const response = await dispatchAiTask(userId, prompt, ...(modelId ? [{ modelId }] : []));

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

  // Guard: only update emails from the scanned batch (defense against AI hallucination)
  const scannedIds = new Set(emails.map((e) => e.id));
  for (const result of spamResults) {
    if (!scannedIds.has(result.id)) continue;
    const shouldMove = result.spamScore > spamThreshold;
    const updated = await prisma.emailMessage.update({
      where: { id: result.id },
      data: {
        spamScore: Math.min(Math.max(result.spamScore, 0), 1),
        ...(shouldMove ? { folder: "Spam" } : {}),
      },
      select: {
        accountId: true,
        uid: true,
        folder: true,
      },
    });

    // Sync move to IMAP server (best-effort, fire-and-forget)
    if (shouldMove && updated.folder !== "Spam") {
      moveMessage(updated.accountId, updated.folder, updated.uid, "Spam").catch(() => {
        // Already logged inside moveMessage
      });
    }
  }

  return JSON.stringify({
    processed: emails.length,
    analyzed: spamResults.length,
    movedToSpam: spamResults.filter((r: { spamScore: number }) => r.spamScore > spamThreshold)
      .length,
    results: spamResults,
  });
}
