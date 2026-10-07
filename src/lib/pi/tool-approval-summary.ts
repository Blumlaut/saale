import { prisma } from "@/lib/db";
import { formatDateTimeValue, summarizeToolAction } from "./tool-infos";
import { resolveToolSummary } from "./tool-summary-resolver";

/**
 * Server-side approval summary resolver.
 *
 * The client-safe {@link summarizeToolAction} covers calls whose arguments
 * already say what they are about (to/subject for mail_send, title for
 * calendar_create, …). But several approval-worthy tools only carry an ID
 * (calendar_delete, task_delete, chat_respond, job_run, …) — the user cannot
 * judge "what is this about" from a bare ID, so this module resolves the
 * subject from the user's own records and folds it into the summary line.
 *
 * Every query is scoped to `userId` — an approval card must never leak
 * another user's data, even if an attacker submits a guessed ID.
 */

/**
 * Resolve a human-facing subject for a tool call, or null when the tool has
 * nothing to add (no summary derivable, or the referenced record is not
 * found / belongs to someone else).
 */
type SubjectResolver = (userId: string, args: Record<string, unknown>) => Promise<string | null>;

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const SUBJECT_RESOLVERS: Record<string, SubjectResolver> = {
  calendar_delete: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const event = await prisma.calendarEvent.findFirst({
      where: { id, calendar: { account: { userId } } },
      select: { summary: true, dtStart: true },
    });
    if (!event) return null;
    const start = formatDateTimeValue(event.dtStart.toISOString());
    return `Delete event "${event.summary}"${start ? ` — ${start}` : ""}`;
  },
  calendar_update: async (userId, args) => {
    // summarizeToolAction covers the case where the new title is in the args.
    if (str(args.summary)) return null;
    const id = str(args.id);
    if (!id) return null;
    const event = await prisma.calendarEvent.findFirst({
      where: { id, calendar: { account: { userId } } },
      select: { summary: true },
    });
    return event ? `Update event "${event.summary}"` : null;
  },
  task_delete: async (userId, args) => {
    const id = str(args.taskId);
    if (!id) return null;
    const task = await prisma.task.findFirst({ where: { id, userId }, select: { title: true } });
    return task ? `Delete task "${task.title}"` : null;
  },
  task_update: async (userId, args) => {
    if (str(args.title)) return null;
    const id = str(args.taskId);
    if (!id) return null;
    const task = await prisma.task.findFirst({ where: { id, userId }, select: { title: true } });
    return task ? `Update task "${task.title}"` : null;
  },
  chat_respond: async (userId, args) => {
    const id = str(args.sessionId);
    if (!id) return null;
    const session = await prisma.chatSession.findFirst({
      where: { id, userId },
      select: { title: true },
    });
    return session ? `Send a message in chat "${session.title}"` : null;
  },
  chat_delete: async (userId, args) => {
    const id = str(args.sessionId);
    if (!id) return null;
    const session = await prisma.chatSession.findFirst({
      where: { id, userId },
      select: { title: true },
    });
    return session ? `Delete chat "${session.title}"` : null;
  },
  mail_delete: async (userId, args) => {
    const emailIds = ids(args.ids);
    if (emailIds.length === 0) return null;
    const emails = await prisma.emailMessage.findMany({
      where: { id: { in: emailIds }, account: { userId } },
      select: { subject: true, fromEmail: true },
    });
    if (emails.length === 0) return null;
    return summarizeEmails(emails, (n) => `Delete ${n} email${n === 1 ? "" : "s"}`);
  },
  mail_tag: async (userId, args) => {
    const emailIds = ids(args.ids);
    if (emailIds.length === 0) return null;
    const emails = await prisma.emailMessage.findMany({
      where: { id: { in: emailIds }, account: { userId } },
      select: { subject: true, fromEmail: true },
    });
    if (emails.length === 0) return null;
    return summarizeEmails(emails, (n) => `Tag ${n} email${n === 1 ? "" : "s"}`);
  },
  mail_move: async (userId, args) => {
    const emailIds = ids(args.ids);
    if (emailIds.length === 0) return null;
    const folder = str(args.folder);
    const emails = await prisma.emailMessage.findMany({
      where: { id: { in: emailIds }, account: { userId } },
      select: { subject: true, fromEmail: true },
    });
    if (emails.length === 0) return null;
    return summarizeEmails(
      emails,
      (n) => `Move ${n} email${n === 1 ? "" : "s"}${folder ? ` to "${folder}"` : ""}`,
    );
  },
  job_run: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const job = await prisma.queueTask.findFirst({
      where: { id, userId },
      select: { name: true, type: true },
    });
    return job ? `Run job "${job.name ?? job.type}" now` : null;
  },
  job_enable: async (userId, args) => {
    const id = str(args.id);
    const enabled = typeof args.enabled === "boolean" ? args.enabled : null;
    if (!id || enabled === null) return null;
    const job = await prisma.queueTask.findFirst({
      where: { id, userId },
      select: { name: true, type: true },
    });
    if (!job) return null;
    return `${enabled ? "Enable" : "Disable"} job "${job.name ?? job.type}"`;
  },
  job_update: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const job = await prisma.queueTask.findFirst({
      where: { id, userId },
      select: { name: true, type: true },
    });
    return job ? `Update job "${job.name ?? job.type}"` : null;
  },
  job_delete: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const job = await prisma.queueTask.findFirst({
      where: { id, userId },
      select: { name: true, type: true },
    });
    return job ? `Delete job "${job.name ?? job.type}"` : null;
  },
  agent_job_run: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const def = await prisma.agentDefinition.findFirst({
      where: { id, userId },
      select: { name: true },
    });
    return def ? `Run agent job "${def.name}" now` : null;
  },
  agent_job_update: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const def = await prisma.agentDefinition.findFirst({
      where: { id, userId },
      select: { name: true },
    });
    return def ? `Update agent job "${def.name}"` : null;
  },
  agent_job_delete: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const def = await prisma.agentDefinition.findFirst({
      where: { id, userId },
      select: { name: true },
    });
    return def ? `Delete agent job "${def.name}" and its runs` : null;
  },
  infra_remove_machine: async (userId, args) => {
    const id = str(args.id);
    if (!id) return null;
    const machine = await prisma.infraMachine.findFirst({
      where: { id, userId },
      select: { name: true },
    });
    return machine ? `Remove machine "${machine.name}" and its notes` : null;
  },
};

/** "Delete 1 email — \"Re: Invoice\" from jane@example.com" (first of N for many). */
function summarizeEmails(
  emails: { subject: string; fromEmail: string }[],
  verb: (n: number) => string,
): string {
  const n = emails.length;
  const first = emails[0];
  if (!first) return verb(n);
  const head = verb(n) + ` — "${first.subject}" from ${first.fromEmail}`;
  return n > 1 ? `${head} (and ${n - 1} more)` : head;
}

/**
 * One-line "what is this call about" for an approval request.
 *
 * Combines the client-safe argument summary with, where the call only carries
 * an ID, a lookup of the referenced record in the user's own data. Never
 * throws — a failure simply yields null and the dialog falls back to the
 * labeled arguments.
 */
export async function resolveApprovalSummary(
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  try {
    // Infra tools resolve the machine name from an ID — the shared resolver
    // already handles that and the catalog templates. Tools with a dedicated
    // subject resolver win (a template with an unresolved placeholder is
    // worse than no summary).
    if (toolName.startsWith("infra_")) {
      const resolver = SUBJECT_RESOLVERS[toolName];
      if (resolver) return await resolver(userId, args);
      return await resolveToolSummary(toolName, args, userId);
    }

    const base = summarizeToolAction(toolName, args);
    const resolver = SUBJECT_RESOLVERS[toolName];
    if (!resolver) return base;

    const subject = await resolver(userId, args);
    return subject ?? base;
  } catch (err) {
    console.error(`Failed to resolve approval summary for ${toolName}:`, err);
    return null;
  }
}
