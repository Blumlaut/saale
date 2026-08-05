import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { prisma } from "@/lib/db";
import { pushEventToCalDAV } from "@/lib/calendar/caldav";

/**
 * Create calendar tools with userId injection for user isolation.
 * All queries are scoped to the authenticated user's calendars.
 * Returns an array of tool definitions for direct spread into the agent session.
 */
export function createCalendarTools(userId: string): ToolDefinition[] {
  /** Find a single event, scoped to user */
  async function findEventByUser(eventId: string, options?: { includeCalendar?: boolean }) {
    return prisma.calendarEvent.findFirst({
      where: {
        id: eventId,
        calendar: { account: { userId } },
      },
      ...(options?.includeCalendar ? { include: { calendar: true } } : {}),
    });
  }

  /** Fetch events with user isolation and serialize for tool response */
  async function queryEvents(whereClause: Record<string, unknown>) {
    const events = await prisma.calendarEvent.findMany({
      where: whereClause,
      orderBy: { dtStart: "asc" },
      take: 20,
      include: {
        calendar: {
          select: { id: true, name: true, color: true },
        },
      },
    });

    return events.map((e) => ({
      id: e.id,
      uid: e.uid,
      summary: e.summary,
      description: e.description,
      location: e.location,
      dtStart: e.dtStart.toISOString(),
      dtEnd: e.dtEnd?.toISOString() ?? null,
      allDay: e.allDay,
      calendarName: e.calendar.name,
      calendarColor: e.calendar.color,
    }));
  }

  return [
    // ─── calendar_list ──────────────────────────────────────────────────────

    defineTool({
      name: "calendar_list",
      label: "List Calendars",
      description: "List all connected calendars with their names, colors, and event counts.",
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params) => {
        const calendars = await prisma.calendar.findMany({
          where: {
            account: { userId },
            enabled: true,
          },
          select: {
            id: true,
            name: true,
            color: true,
            enabled: true,
            _count: { select: { events: true } },
            account: { select: { name: true } },
          },
          orderBy: { name: "asc" },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  count: calendars.length,
                  calendars: calendars.map((c) => ({
                    id: c.id,
                    name: c.name,
                    color: c.color,
                    accountName: c.account.name,
                    eventCount: c._count.events,
                  })),
                },
                null,
                2,
              ),
            },
          ],
          details: { count: calendars.length },
        };
      },
    }),

    // ─── calendar_upcoming ──────────────────────────────────────────────────

    defineTool({
      name: "calendar_upcoming",
      label: "Upcoming Events",
      description:
        "Get upcoming calendar events. Specify hours or days to look ahead (default: next 24 hours).",
      parameters: Type.Object({
        hours: Type.Optional(
          Type.Integer({
            description: "Hours to look ahead. Mutually exclusive with 'days'.",
          }),
        ),
        days: Type.Optional(
          Type.Integer({
            description: "Days to look ahead. Mutually exclusive with 'hours'.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum number of events to return. Default: 20.",
            default: 20,
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const now = new Date();
        const end = new Date();
        if (params.days) {
          end.setDate(end.getDate() + params.days);
        } else if (params.hours) {
          end.setHours(end.getHours() + params.hours);
        } else {
          end.setHours(end.getHours() + 24);
        }

        const events = await queryEvents({
          calendar: { account: { userId }, enabled: true },
          dtStart: { gte: now, lte: end },
        });

        // Structured metadata for UI rendering (calendar cards)
        const calMeta = {
          _saaleCalMeta: {
            type: "calendar_upcoming" as const,
            from: now.toISOString(),
            to: end.toISOString(),
            count: events.length,
            events,
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
                  {
                    from: now.toISOString(),
                    to: end.toISOString(),
                    count: events.length,
                    events,
                  },
                  null,
                  2,
                ) + `\n${JSON.stringify(calMeta)}`,
            },
          ],
          details: { count: events.length },
        };
      },
    }),

    // ─── calendar_search ────────────────────────────────────────────────────

    defineTool({
      name: "calendar_search",
      label: "Search Events",
      description:
        "Search calendar events by keyword. Matches against title, description, and location.",
      parameters: Type.Object({
        query: Type.String({
          description: "Search query (matches title, description, location).",
        }),
        limit: Type.Optional(
          Type.Integer({
            description: "Maximum results. Default: 20.",
            default: 20,
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const events = await queryEvents({
          calendar: { account: { userId }, enabled: true },
          OR: [
            { summary: { contains: params.query, mode: "insensitive" } },
            { description: { contains: params.query, mode: "insensitive" } },
            { location: { contains: params.query, mode: "insensitive" } },
          ],
        });

        // Structured metadata for UI rendering (calendar cards)
        const calMeta = {
          _saaleCalMeta: {
            type: "calendar_search" as const,
            query: params.query,
            count: events.length,
            events,
          },
        };

        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify(
                  {
                    query: params.query,
                    count: events.length,
                    events,
                  },
                  null,
                  2,
                ) + `\n${JSON.stringify(calMeta)}`,
            },
          ],
          details: { count: events.length },
        };
      },
    }),

    // ─── calendar_create ────────────────────────────────────────────────────

    defineTool({
      name: "calendar_create",
      label: "Create Event",
      description:
        "Create a new calendar event. If the target calendar is CalDAV-synced, the event is pushed to the remote server.",
      parameters: Type.Object({
        calendarId: Type.String({
          description: "Calendar ID to create the event in.",
        }),
        summary: Type.String({
          description: "Event title.",
        }),
        dtStart: Type.String({
          description: "Start datetime (ISO 8601).",
        }),
        dtEnd: Type.Optional(
          Type.String({
            description: "End datetime (ISO 8601). Defaults to start + 1 hour.",
          }),
        ),
        description: Type.Optional(
          Type.String({
            description: "Event description.",
          }),
        ),
        location: Type.Optional(
          Type.String({
            description: "Event location.",
          }),
        ),
        allDay: Type.Optional(
          Type.Boolean({
            description: "Whether this is an all-day event.",
          }),
        ),
        timeZone: Type.Optional(
          Type.String({
            description: "Timezone identifier (e.g. 'Europe/Berlin').",
          }),
        ),
        recurrenceRule: Type.Optional(
          Type.String({
            description: "RRULE string for recurring events.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        // Verify calendar belongs to user
        const calendar = await prisma.calendar.findFirst({
          where: {
            id: params.calendarId,
            account: { userId },
          },
          include: { account: true },
        });
        if (!calendar) {
          throw new Error(`Calendar ${params.calendarId} not found`);
        }

        const uid = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@saale`;
        const dtStart = new Date(params.dtStart);
        const dtEnd = params.dtEnd
          ? new Date(params.dtEnd)
          : new Date(dtStart.getTime() + 60 * 60 * 1000);

        const eventData = {
          uid,
          summary: params.summary,
          description: params.description ?? null,
          location: params.location ?? null,
          dtStart,
          dtEnd,
          allDay: params.allDay ?? false,
          timeZone: params.timeZone ?? null,
          recurrenceRule: params.recurrenceRule ?? null,
          status: null,
          transparency: null,
        };

        const event = await prisma.calendarEvent.create({
          data: {
            calendarId: params.calendarId,
            ...eventData,
            source: "manual",
          },
        });

        // Push to CalDAV if applicable
        let caldavResult: { success: boolean; error: string | null } | null = null;
        if (calendar.remoteId) {
          caldavResult = await pushEventToCalDAV(params.calendarId, eventData);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  created: true,
                  event: {
                    id: event.id,
                    uid: event.uid,
                    summary: event.summary,
                    dtStart: event.dtStart.toISOString(),
                    dtEnd: event.dtEnd?.toISOString() ?? null,
                  },
                  caldavPush: caldavResult
                    ? caldavResult.success
                      ? "pushed"
                      : `failed: ${caldavResult.error}`
                    : "not a caldav calendar",
                },
                null,
                2,
              ),
            },
          ],
          details: { id: event.id, caldavPush: caldavResult?.success ?? false },
        };
      },
    }),

    // ─── calendar_update ────────────────────────────────────────────────────

    defineTool({
      name: "calendar_update",
      label: "Update Event",
      description: "Update an existing calendar event by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Event ID.",
        }),
        summary: Type.Optional(
          Type.String({
            description: "New event title.",
          }),
        ),
        dtStart: Type.Optional(
          Type.String({
            description: "New start datetime (ISO 8601).",
          }),
        ),
        dtEnd: Type.Optional(
          Type.String({
            description: "New end datetime (ISO 8601).",
          }),
        ),
        description: Type.Optional(
          Type.String({
            description: "New description.",
          }),
        ),
        location: Type.Optional(
          Type.String({
            description: "New location.",
          }),
        ),
        allDay: Type.Optional(
          Type.Boolean({
            description: "Whether this is an all-day event.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const event = await findEventByUser(params.id);
        if (!event) {
          throw new Error(`Event ${params.id} not found`);
        }

        const updateData: Record<string, unknown> = {};
        if (params.summary !== undefined) updateData.summary = params.summary;
        if (params.dtStart !== undefined) updateData.dtStart = new Date(params.dtStart);
        if (params.dtEnd !== undefined)
          updateData.dtEnd = params.dtEnd ? new Date(params.dtEnd) : null;
        if (params.description !== undefined) updateData.description = params.description;
        if (params.location !== undefined) updateData.location = params.location;
        if (params.allDay !== undefined) updateData.allDay = params.allDay;

        const updated = await prisma.calendarEvent.update({
          where: { id: params.id },
          data: updateData,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  updated: true,
                  event: {
                    id: updated.id,
                    summary: updated.summary,
                    dtStart: updated.dtStart.toISOString(),
                    dtEnd: updated.dtEnd?.toISOString() ?? null,
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: { id: updated.id },
        };
      },
    }),

    // ─── calendar_delete ────────────────────────────────────────────────────

    defineTool({
      name: "calendar_delete",
      label: "Delete Event",
      description: "Delete a calendar event by its ID.",
      parameters: Type.Object({
        id: Type.String({
          description: "Event ID to delete.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const event = await findEventByUser(params.id, { includeCalendar: true });
        if (!event) {
          throw new Error(`Event ${params.id} not found`);
        }

        await prisma.calendarEvent.delete({
          where: { id: params.id },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  deleted: true,
                  id: params.id,
                  summary: event.summary,
                },
                null,
                2,
              ),
            },
          ],
          details: { id: params.id },
        };
      },
    }),
  ];
}
