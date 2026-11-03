import { prisma } from "@/lib/db";
import { batchSizeField, emailAccountField, maxEmailAgeField, modelField } from "./_helpers";
import type { FieldDef } from "@/lib/queue/job-schemas";
import { runEmailAiJob, type PromptableEmail } from "./email-ai";

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
  const { batch, applied, results } = await runEmailAiJob<
    PromptableEmail,
    { id: string; summary: string }
  >({
    ...params,
    context: "job/summarization",
    where: { aiSummary: null },
    select: {
      id: true,
      subject: true,
      fromEmail: true,
      bodyPreview: true,
      bodyText: true,
    },
    defaultLimit: 10,
    task: "summarize",
    instructions:
      "For each email, write a concise 1-2 sentence summary capturing the key point or action needed. Return a JSON object with a 'summaries' array where each item has 'id' and 'summary'.",
    resultKey: "summaries",
    accept: (entry) => Boolean(entry.id) && typeof entry.summary === "string",
    apply: async (email, entry) => {
      await prisma.emailMessage.update({
        where: { id: email.id },
        data: { aiSummary: entry.summary },
      });
    },
  });

  return JSON.stringify({ processed: batch.length, summarized: applied, summaries: results });
}
