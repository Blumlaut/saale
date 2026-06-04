import { prisma } from "@/lib/db";
import { extractEventsFromEmails } from "@/lib/calendar/email-extraction";

export const metadata = {
  type: "email_to_calendar",
  label: "Email → Calendar",
  description: "Scan emails for appointment-like content and create calendar events",
  icon: "CalendarPlus",
  defaultCron: "0 */4 * * *",
  usesAi: true,
} as const;

export const fields = [
  {
    key: "accountId",
    label: "Email Account",
    description: "Leave empty to scan all enabled email accounts",
    type: "select" as const,
    default: "",
    options: [] as Array<{ value: string; label: string }>,
  },
  {
    key: "targetCalendarId",
    label: "Target Calendar",
    description: "Calendar to create events in (leave empty for default calendar)",
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
    max: 100,
    step: 1,
  },
  {
    key: "maxEmailAge",
    label: "Max email age",
    description: "Only scan emails received within this many hours (0 = no limit)",
    type: "number" as const,
    default: 48,
    min: 0,
    max: 720,
    step: 1,
  },
  {
    key: "modelId",
    label: "AI Model",
    description: "Model used for event extraction",
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
