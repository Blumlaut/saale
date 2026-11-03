import { prisma } from "@/lib/db";
import { batchSizeField, emailAccountField, maxEmailAgeField, modelField } from "./_helpers";
import type { FieldDef } from "@/lib/queue/job-schemas";
import { runEmailAiJob, type PromptableEmail } from "./email-ai";

export const metadata = {
  type: "classification",
  label: "Classification + Tags",
  description: "Auto-tag incoming emails with AI categories",
  icon: "Tags",
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

const TAGS = [
  "finance",
  "schedule",
  "newsletter",
  "security",
  "social",
  "work",
  "personal",
  "shopping",
  "travel",
  "health",
  "news",
  "promotion",
  "notification",
];

interface ClassifiableEmail extends PromptableEmail {
  tags: string[];
}

export async function handler(params: {
  config: Record<string, unknown>;
  userId: string;
  modelId?: string | null;
}) {
  const { batch, results, applied } = await runEmailAiJob<
    ClassifiableEmail,
    { id: string; tags: string[] }
  >({
    ...params,
    context: "job/classification",
    where: { classified: false },
    select: {
      id: true,
      subject: true,
      fromEmail: true,
      bodyPreview: true,
      bodyText: true,
      tags: true,
    },
    defaultLimit: 10,
    task: "classify",
    instructions: `For each email, assign relevant category tags from this list: ${TAGS.join(", ")}. Return a JSON object with a 'classifications' array where each item has 'id' and 'tags' (array of strings).`,
    resultKey: "classifications",
    accept: (entry) => Boolean(entry.id) && Array.isArray(entry.tags),
    apply: async (email, entry) => {
      const tags = Array.from(new Set([...(email.tags ?? []), ...entry.tags]));
      await prisma.emailMessage.update({
        where: { id: email.id },
        data: { tags, classified: true },
      });
    },
  });

  return JSON.stringify({ processed: batch.length, classified: applied, classifications: results });
}
