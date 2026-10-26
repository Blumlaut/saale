/**
 * The fields an event can be created or edited with, and the body both
 * requests send.
 */

import type { CalendarEvent } from "@/types/shared";

export interface EventDraft {
  summary: string;
  description: string;
  location: string;
  /** `datetime-local` value, or a date when the event lasts all day. */
  dtStart: string;
  dtEnd: string;
  allDay: boolean;
}

export const EMPTY_EVENT_DRAFT: EventDraft = {
  summary: "",
  description: "",
  location: "",
  dtStart: "",
  dtEnd: "",
  allDay: false,
};

/** A draft filled from an event the calendar already has. */
export function draftFromEvent(event: CalendarEvent): EventDraft {
  return {
    summary: event.summary,
    description: event.description ?? "",
    location: event.location ?? "",
    dtStart: event.dtStart.substring(0, 16),
    dtEnd: event.dtEnd ? event.dtEnd.substring(0, 16) : "",
    allDay: event.allDay,
  };
}

/** A draft starting at `date` and running an hour. */
export function draftForDate(date: Date): Pick<EventDraft, "dtStart" | "dtEnd"> {
  const end = new Date(date);
  end.setHours(end.getHours() + 1);
  return {
    dtStart: date.toISOString().substring(0, 16),
    dtEnd: end.toISOString().substring(0, 16),
  };
}

/** The event body a create or update request carries. */
export function eventDraftPayload(draft: EventDraft) {
  return {
    summary: draft.summary,
    description: draft.description || null,
    location: draft.location || null,
    dtStart: new Date(draft.dtStart).toISOString(),
    dtEnd: draft.dtEnd ? new Date(draft.dtEnd).toISOString() : null,
    allDay: draft.allDay,
  };
}
