import { prisma } from "@/lib/db";
import { batchSizeField, emailAccountField, maxEmailAgeField, modelField } from "./_helpers";
import type { FieldDef } from "@/lib/queue/job-schemas";
import { extractEventsFromEmails } from "@/lib/calendar/email-extraction";

export const metadata = {
  type: "email_to_calendar",
  label: "Email → Calendar",
  description: "Scan emails for appointment-like content and create calendar events",
  icon: "CalendarPlus",
  defaultCron: "0 */4 * * *",
  usesAi: true,
} as const;

export const fields: FieldDef[] = [
  emailAccountField("Email Account", "Leave empty to scan all enabled email accounts"),
  {
    key: "targetCalendarId",
    label: "Target Calendar",
    description: "Calendar to create events in (leave empty for default calendar)",
    type: "select",
    default: "",
    options: [],
  },
  batchSizeField({
    description: "Number of emails to scan per run",
    fallback: 20,
    max: 100,
  }),
  maxEmailAgeField({ verb: "scan", fallback: 48 }),
  modelField("Model used for event extraction"),
];

export async function handler(params: {
  config: Record<string, unknown>;
  userId: string;
  modelId?: string | null;
}) {
  const { config, userId, modelId } = params;

  // Validate target calendar belongs to user (defense in depth)
  let effectiveTargetCalendarId: string | undefined;
  if (config.targetCalendarId) {
    const targetCal = await prisma.calendar.findFirst({
      where: { id: config.targetCalendarId as string, account: { userId } },
    });
    if (!targetCal) {
      throw new Error(`Calendar ${config.targetCalendarId} not found`);
    }
    effectiveTargetCalendarId = config.targetCalendarId as string;
  }

  const result = await extractEventsFromEmails({
    userId,
    ...(config.accountId ? { accountId: config.accountId as string } : {}),
    ...(effectiveTargetCalendarId ? { targetCalendarId: effectiveTargetCalendarId } : {}),
    limit: (config.limit as number) ?? 20,
    maxEmailAge: (config.maxEmailAge as number) ?? 48,
    ...(modelId ? { modelId } : {}),
  });
  return JSON.stringify(result);
}
