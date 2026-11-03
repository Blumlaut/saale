import { prisma } from "@/lib/db";
import { aiResultList, readAiJson } from "@/lib/pi/ai-json";
import { dispatchAiJob } from "@/lib/queue/job-handler";
import { resolveUserEmailAccountIds } from "@/lib/queue/user-isolation";

/**
 * The shape the email-batch jobs share: classification, summarization and spam
 * filtering each take the user's accounts, a batch of emails inside an age
 * window, and one instruction per email, then write the model's verdict back.
 *
 * What differs is only what the job is about, so it arrives as props: the extra
 * row filter, the prompt, and what to do with one accepted result.
 */

/** How much of an email the prompt carries. */
const PREVIEW_CHARS = 3000;

/** The fields every one of these jobs has to read to build its prompt. */
export interface PromptableEmail {
  id: string;
  subject: string | null;
  fromEmail: string;
  bodyPreview: string | null;
  bodyText: string | null;
}

export interface EmailAiJobOptions<TRow extends PromptableEmail, TResult> {
  userId: string;
  config: Record<string, unknown>;
  modelId?: string | null;
  /** Conditions on top of the owner, the account and the age window. */
  where: Record<string, unknown>;
  /** Row fields the prompt and the write need; the caller owns the type. */
  select: Record<string, boolean>;
  /** Batch size when the job's config leaves it out. */
  defaultLimit: number;
  task: string;
  instructions: string;
  /** The key the model's array of results lands under. */
  resultKey: string;
  /** Whether an entry carries everything the job needs to write. */
  accept: (entry: Record<string, unknown>) => boolean;
  apply: (row: TRow, entry: TResult) => Promise<void>;
  /** Names the job in log lines. */
  context: string;
}

export interface EmailAiJobResult<TRow, TResult> {
  /** The emails the run looked at. */
  batch: TRow[];
  /** The accounts the batch was read from, for a write that has to reach IMAP. */
  accountIds: string[];
  /** The results that survived `accept`. */
  results: TResult[];
  /** How many of them belonged to the batch and were written. */
  applied: number;
}

/**
 * Run one email-batch job.
 *
 * The ids the model answers with are checked against the batch before anything
 * is written: a model that invents or repeats an id cannot reach a row the run
 * never scanned.
 */
export async function runEmailAiJob<TRow extends PromptableEmail, TResult>(
  options: EmailAiJobOptions<TRow, TResult>,
): Promise<EmailAiJobResult<TRow, TResult>> {
  const { config, userId } = options;
  const accountIds = await resolveUserEmailAccountIds(
    userId,
    config.accountId as string | undefined,
  );

  const where: Record<string, unknown> = {
    accountId: { in: accountIds },
    ...(config.accountId ? { accountId: config.accountId } : {}),
    ...options.where,
  };
  const maxAgeHours = Number(config.maxEmailAge ?? 0);
  if (maxAgeHours > 0) {
    where.date = { gte: new Date(Date.now() - maxAgeHours * 60 * 60 * 1000) };
  }

  const requestedLimit = Number(config.limit);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : options.defaultLimit;

  const batch = (await prisma.emailMessage.findMany({
    where,
    orderBy: { date: "desc" },
    take: limit,
    select: options.select,
  })) as unknown as TRow[];

  if (batch.length === 0) return { batch, accountIds, results: [], applied: 0 };

  const answer = await dispatchAiJob(
    userId,
    JSON.stringify({
      task: options.task,
      instructions: options.instructions,
      emails: batch.map((email) => ({
        id: email.id,
        from: email.fromEmail,
        subject: email.subject,
        preview: (email.bodyText ?? email.bodyPreview)?.slice(0, PREVIEW_CHARS),
      })),
    }),
    ...(options.modelId ? [{ modelId: options.modelId }] : []),
  );

  const results = aiResultList(readAiJson(answer, options.context), options.resultKey).filter(
    options.accept,
  ) as TResult[];

  const byId = new Map(batch.map((row) => [row.id, row]));
  let applied = 0;
  for (const result of results) {
    const row = byId.get(String((result as { id?: unknown }).id));
    if (!row) continue;
    await options.apply(row, result);
    applied++;
  }

  return { batch, accountIds, results, applied };
}
