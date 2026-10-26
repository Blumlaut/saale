/**
 * The loop both email extraction jobs (tasks, calendar events) run: take the
 * emails that have not been read yet, ask a model about each one, and record
 * what came out of it.
 */

import { prisma } from "@/lib/db";
import { dispatchAiJob } from "@/lib/queue/job-handler";

/** The column that marks an email as read by one extractor. */
export type ScannedFlag = "calendarScanned" | "taskScanned";

/** An email as the extractors read it. */
export interface ScannedEmail {
  id: string;
  subject: string;
  bodyText: string | null;
  bodyPreview: string | null;
  date: Date;
  accountId: string;
}

/** What one email produced. One email can carry several tasks, or an event. */
export interface ScanOutcome {
  created?: number;
  skipped?: number;
  /** Reasons a piece of one email failed, kept with the run's other errors. */
  errors?: string[];
}

export interface ScanResult {
  emailsScanned: number;
  created: number;
  skipped: number;
  errors: string[];
}

/** The age cut-off an email scan applies, or nothing when the limit is off. */
function emailAgeCutoff(maxEmailAge: number | undefined): Date | undefined {
  if (!maxEmailAge || maxEmailAge <= 0) return undefined;
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - maxEmailAge);
  return cutoff;
}

/**
 * Run an extractor over the user's unread emails.
 *
 * The scan flag is set before the extractor runs, so a retry does not read the
 * same email twice.
 */
export async function scanUnreadEmails(params: {
  /** Prefixes the log lines, e.g. "task-extraction". */
  tag: string;
  scannedFlag: ScannedFlag;
  userId: string;
  accountId?: string | undefined;
  limit?: number | undefined;
  maxEmailAge?: number | undefined;
  process: (email: ScannedEmail) => Promise<ScanOutcome>;
}): Promise<ScanResult> {
  const where: Record<string, unknown> =
    params.scannedFlag === "calendarScanned" ? { calendarScanned: false } : { taskScanned: false };
  if (params.accountId) where.accountId = params.accountId;

  const cutoff = emailAgeCutoff(params.maxEmailAge);
  if (cutoff) where.date = { gte: cutoff };

  const emails = await prisma.emailMessage.findMany({
    where,
    orderBy: { date: "desc" },
    take: Math.min(params.limit ?? 20, 100),
    select: {
      id: true,
      subject: true,
      bodyText: true,
      bodyPreview: true,
      date: true,
      accountId: true,
    },
  });

  let created = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const email of emails) {
    try {
      await prisma.emailMessage.update({
        where: { id: email.id },
        data:
          params.scannedFlag === "calendarScanned"
            ? { calendarScanned: true }
            : { taskScanned: true },
      });

      const outcome = await params.process(email);
      created += outcome.created ?? 0;
      skipped += outcome.skipped ?? 0;
      if (outcome.errors) errors.push(...outcome.errors);
    } catch (err) {
      const emailErr = err as Error;
      console.error(`[${params.tag}] Failed to process email ${email.id}:`, emailErr.message);
      errors.push(`Failed to process email "${email.subject.slice(0, 50)}": ${emailErr.message}`);
    }
  }

  return { emailsScanned: emails.length, created, skipped, errors };
}

/**
 * Ask a model for JSON and hand back what it parsed, or null when it answered
 * nothing usable.
 */
export async function askForJson<T>(
  userId: string,
  prompt: Record<string, unknown>,
  options: { modelId?: string | null | undefined; tag: string },
): Promise<T | null> {
  const response = await dispatchAiJob(userId, JSON.stringify(prompt), {
    modelId: options.modelId ?? null,
  });
  const text = response.trim();

  if (!text || text === "null" || text === "NULL") return null;

  try {
    // A model often wraps its answer in a markdown fence.
    const cleaned = text.replace(/```(?:json)?\n?/g, "").trim();
    return JSON.parse(cleaned) as T;
  } catch (err) {
    console.warn(`[${options.tag}] Failed to parse AI response:`, text.slice(0, 200), err);
    return null;
  }
}
