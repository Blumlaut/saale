import { prisma } from "@/lib/db";
import { dispatchAiJob } from "@/lib/queue/job-handler";

export interface ExtractedEvent {
  title: string;
  startDate: string; // ISO date string
  startTime?: string; // "HH:MM" or null for all-day
  endDate?: string; // ISO date string
  endTime?: string; // "HH:MM" or null
  allDay?: boolean;
  location?: string;
  description?: string;
}

/**
 * System prompt for event extraction from emails.
 */
const EXTRACT_EVENTS_PROMPT = `You are an event extraction assistant. Analyze the given email and determine if it describes a scheduled event, appointment, meeting, deadline, or time-bound commitment.

If the email describes an event, extract the details in JSON format. Be conservative — only extract when you're confident about both the event nature and the date/time.

Rules:
- The startDate must be a valid ISO date (YYYY-MM-DD). Use the current date as reference for relative dates ("next Tuesday", "tomorrow").
- If no specific end time is mentioned, assume the event lasts 1 hour (for timed events) or 1 day (for all-day events).
- All-day events should have allDay: true and no startTime/endTime.
- Skip generic newsletters, promotional emails, or emails without clear date/time references.
- For recurring events, extract only the first occurrence.

Current date: {{CURRENT_DATE}}

Respond with a JSON object. If no event is found, respond with null.`;

/**
 * Scan emails for appointment-like content and create calendar events.
 *
 * @param params Configuration for the extraction job
 * @returns Summary of the extraction run
 */
export async function extractEventsFromEmails(params: {
  userId: string;
  accountId?: string; // Email account ID (empty = all accounts)
  targetCalendarId?: string; // Calendar to create events in
  limit?: number; // Max emails to scan
  maxEmailAge?: number; // Max age in hours (0 = no limit)
  modelId?: string | null; // AI model override
}): Promise<{
  emailsScanned: number;
  eventsCreated: number;
  eventsSkipped: number;
  errors: string[];
}> {
  let emailsScanned = 0;
  let eventsCreated = 0;
  let eventsSkipped = 0;
  const errors: string[] = [];

  // Fetch candidate emails
  const where: Record<string, unknown> = {
    calendarScanned: false,
  };

  if (params.accountId) {
    where.accountId = params.accountId;
  }

  if (params.maxEmailAge && params.maxEmailAge > 0) {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - params.maxEmailAge);
    where.date = { gte: cutoff };
  }

  const limit = Math.min(params.limit ?? 20, 100);
  const emails = await prisma.emailMessage.findMany({
    where,
    orderBy: { date: "desc" },
    take: limit,
    select: {
      id: true,
      subject: true,
      bodyText: true,
      bodyPreview: true,
      date: true,
      accountId: true,
    },
  });

  for (const email of emails) {
    emailsScanned++;

    try {
      // Mark as scanned immediately to avoid re-processing on retry
      await prisma.emailMessage.update({
        where: { id: email.id },
        data: { calendarScanned: true },
      });

      const extracted = await extractSingleEvent(email, params.userId, params.modelId);

      if (!extracted) {
        eventsSkipped++;
        continue;
      }

      // Validate extracted data
      if (!validateExtractedEvent(extracted)) {
        eventsSkipped++;
        continue;
      }

      // Dedup check (scoped to user's calendars)
      const isDuplicate = await checkDuplicate(extracted, params.userId, params.targetCalendarId);
      if (isDuplicate) {
        eventsSkipped++;
        continue;
      }

      // Create calendar event (scoped to user's calendars)
      await createCalendarEvent(extracted, params.userId, params.targetCalendarId, email.id);
      eventsCreated++;
    } catch (err) {
      const emailErr = err as Error;
      console.error(`[email-to-calendar] Failed to process email ${email.id}:`, emailErr.message);
      errors.push(`Failed to process email "${email.subject.slice(0, 50)}": ${emailErr.message}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[email-to-calendar] Done: ${emailsScanned} scanned, ${eventsCreated} created, ` +
      `${eventsSkipped} skipped, ${errors.length} errors`,
  );

  return { emailsScanned, eventsCreated, eventsSkipped, errors };
}

/**
 * Extract event data from a single email using AI.
 */
async function extractSingleEvent(
  email: {
    subject: string;
    bodyText: string | null;
    bodyPreview: string;
    date: Date;
  },
  userId: string,
  modelId?: string | null,
): Promise<ExtractedEvent | null> {
  const body = email.bodyText ?? email.bodyPreview ?? "";
  const currentDate = new Date().toISOString().split("T")[0] ?? "";

  const systemPrompt = EXTRACT_EVENTS_PROMPT.replace("{{CURRENT_DATE}}", currentDate);

  const prompt = JSON.stringify({
    task: "extract_event",
    instructions: systemPrompt,
    email: {
      subject: email.subject,
      body: body.slice(0, 4000),
    },
  });

  const response = await dispatchAiJob(userId, prompt, {
    modelId: modelId ?? null,
  });
  const text = response.trim();

  if (!text || text === "null" || text === "NULL") {
    return null;
  }

  // Parse JSON response
  try {
    // Handle markdown code blocks
    const cleaned = text.replace(/```(?:json)?\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as ExtractedEvent;

    if (!parsed || !parsed.title || !parsed.startDate) {
      return null;
    }

    return parsed;
  } catch {
    console.warn(`[email-to-calendar] Failed to parse AI response:`, text.slice(0, 200));
    return null;
  }
}

/**
 * Validate extracted event data.
 */
function validateExtractedEvent(event: ExtractedEvent): boolean {
  // Must have title and start date
  if (!event.title || !event.startDate) return false;

  // Start date must be parseable
  const startDate = new Date(event.startDate);
  if (isNaN(startDate.getTime())) return false;

  // If timed, start time must be parseable
  if (event.startTime) {
    const parts = event.startTime.split(":");
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    if (isNaN(hours) || isNaN(minutes)) return false;
  }

  return true;
}

/**
 * Check if an event with similar title and date already exists.
 * Scoped to the user's own calendars — never queries another user's events.
 */
async function checkDuplicate(
  event: ExtractedEvent,
  userId: string,
  targetCalendarId?: string,
): Promise<boolean> {
  const startDate = new Date(event.startDate);
  if (event.startTime) {
    const parts = event.startTime.split(":");
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    startDate.setHours(isNaN(hours) ? 0 : hours, isNaN(minutes) ? 0 : minutes, 0, 0);
  }

  // Search for events within ±1 hour of the same date
  const startBuffer = new Date(startDate.getTime() - 60 * 60 * 1000);
  const endBuffer = new Date(startDate.getTime() + 60 * 60 * 1000);

  const where: Record<string, unknown> = {
    dtStart: { gte: startBuffer, lte: endBuffer },
    source: "email_extraction",
    calendar: { account: { userId } },
  };

  if (targetCalendarId) {
    where.calendarId = targetCalendarId;
  }

  const existing = await prisma.calendarEvent.findMany({
    where,
    take: 50,
    select: { summary: true },
  });

  // Fuzzy match on title (case-insensitive, trimmed)
  const normalizedTitle = event.title.toLowerCase().trim();

  return existing.some((e) => {
    const existingTitle = e.summary.toLowerCase().trim();
    return (
      existingTitle === normalizedTitle ||
      existingTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(existingTitle)
    );
  });
}

/**
 * Create a calendar event from extracted data.
 * Scoped to the user's own calendars — never creates events in another user's calendar.
 */
async function createCalendarEvent(
  event: ExtractedEvent,
  userId: string,
  targetCalendarId?: string,
  sourceEmailId?: string,
): Promise<void> {
  // Find the target calendar
  let calendarId = targetCalendarId;

  if (!calendarId) {
    // Find the first enabled calendar for THIS user only
    const defaultCalendar = await prisma.calendar.findFirst({
      where: { enabled: true, account: { userId } },
      orderBy: { createdAt: "asc" },
    });
    if (!defaultCalendar) {
      throw new Error("No calendar found to create event in");
    }
    calendarId = defaultCalendar.id;
  }

  // Build datetime
  const dtStart = new Date(event.startDate);
  if (event.startTime && !event.allDay) {
    const parts = event.startTime.split(":");
    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);
    dtStart.setHours(isNaN(hours) ? 0 : hours, isNaN(minutes) ? 0 : minutes, 0, 0);
  }

  // Build end datetime
  let dtEnd: Date | null;
  if (event.endDate) {
    dtEnd = new Date(event.endDate);
    if (event.endTime && !event.allDay) {
      const parts = event.endTime.split(":");
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      dtEnd.setHours(isNaN(hours) ? 0 : hours, isNaN(minutes) ? 0 : minutes, 0, 0);
    }
  } else if (event.allDay) {
    dtEnd = new Date(dtStart.getTime() + 24 * 60 * 60 * 1000);
  } else {
    dtEnd = new Date(dtStart.getTime() + 60 * 60 * 1000); // Default 1 hour
  }

  // Generate a unique UID
  const uid = `email-extraction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@saale`;

  await prisma.calendarEvent.create({
    data: {
      calendarId,
      uid,
      summary: event.title,
      description: event.description ?? null,
      location: event.location ?? null,
      dtStart,
      dtEnd,
      allDay: event.allDay ?? false,
      source: "email_extraction",
      sourceEmailId: sourceEmailId ?? null,
    },
  });
}
