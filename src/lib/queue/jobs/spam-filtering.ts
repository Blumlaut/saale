import { prisma } from "@/lib/db";
import { batchSizeField, emailAccountField, maxEmailAgeField, modelField } from "./_helpers";
import type { FieldDef } from "@/lib/queue/job-schemas";
import { moveMessage, deleteMessage } from "@/lib/email/imap";
import { runEmailAiJob, type PromptableEmail } from "./email-ai";

export const metadata = {
  type: "spam_filtering",
  label: "Spam Filtering",
  description: "Evaluate spam score and move flagged emails",
  icon: "Shield",
  defaultCron: "0 */4 * * *",
  usesAi: true,
} as const;

export const fields: FieldDef[] = [
  emailAccountField(),
  batchSizeField({
    description: "Number of emails to scan per run",
    fallback: 20,
    max: 200,
  }),
  {
    key: "spamThreshold",
    label: "Spam threshold",
    description: "Score above which the action is applied (0–1)",
    type: "number",
    default: 0.85,
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: "spamAction",
    label: "Action on spam",
    description: "What to do with emails that exceed the spam threshold",
    type: "select",
    default: "move_to_spam",
    options: [
      { value: "move_to_spam", label: "Move to Spam folder" },
      { value: "delete", label: "Delete" },
    ],
  },
  maxEmailAgeField({ verb: "process", fallback: 24 }),
  modelField(),
];

interface ScannableEmail extends PromptableEmail {
  uid: number;
  folder: string;
  accountId: string;
}

export async function handler(params: {
  config: Record<string, unknown>;
  userId: string;
  modelId?: string | null;
}) {
  const { config } = params;
  const spamThreshold = Number(config.spamThreshold ?? 0.85);
  const spamAction = (config.spamAction as string) ?? "move_to_spam";
  const movedToSpam: string[] = [];
  const deleted: string[] = [];

  const { batch, accountIds, results, applied } = await runEmailAiJob<
    ScannableEmail,
    { id: string; spamScore: number }
  >({
    ...params,
    context: "job/spam-filtering",
    where: { folder: "INBOX", spamScore: null },
    select: {
      id: true,
      subject: true,
      fromEmail: true,
      bodyPreview: true,
      bodyText: true,
      uid: true,
      folder: true,
      accountId: true,
    },
    defaultLimit: 20,
    task: "spam_analysis",
    instructions:
      "For each email, evaluate whether it is likely spam. Return a JSON object with a 'results' array where each item has 'id', 'spamScore' (0-1 float, higher = more likely spam), and 'reason' (brief explanation).",
    resultKey: "results",
    accept: (entry) => Boolean(entry.id) && typeof entry.spamScore === "number",
    apply: async (email, entry) => {
      const isSpam = entry.spamScore > spamThreshold;

      if (isSpam && spamAction === "delete") {
        // Delete: push to IMAP first, then remove from DB
        const message = await prisma.emailMessage.findFirst({
          where: { id: email.id, accountId: { in: accountIds } },
          select: { id: true, uid: true, folder: true, accountId: true },
        });
        if (!message) return;

        deleteMessage(message.accountId, message.folder, message.uid).catch((err) => {
          console.error(`Failed to delete UID ${message.uid} from IMAP:`, err);
        });
        await prisma.emailMessage.delete({ where: { id: email.id } });
        deleted.push(email.id);
        return;
      }

      const updated = await prisma.emailMessage.update({
        where: { id: email.id },
        data: {
          spamScore: Math.min(Math.max(entry.spamScore, 0), 1),
          ...(isSpam ? { folder: "Spam", tags: { push: "filtered" } } : {}),
        },
        select: { accountId: true, uid: true, folder: true },
      });

      // Sync move to IMAP server (best-effort, fire-and-forget)
      if (isSpam && updated.folder !== "Spam") {
        movedToSpam.push(email.id);
        moveMessage(updated.accountId, updated.folder, updated.uid, "Spam").catch((err) => {
          console.error(`Failed to move UID ${updated.uid} to Spam on IMAP:`, err);
        });
      }
    },
  });

  return JSON.stringify({
    processed: batch.length,
    analyzed: results.length,
    flagged: applied,
    movedToSpam: movedToSpam.length,
    deleted: deleted.length,
    results,
  });
}
