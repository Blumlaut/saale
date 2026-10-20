import { Calendar as CalendarIcon, MapPin, Search } from "lucide-react";
import { plural, truncate } from "@/lib/format";
import { extractToolMeta } from "@/lib/chat/tool-meta";
import { toolStatus } from "../tool-status";
import type { ToolCardModel, ToolDescriptor, ToolRowModel } from "../tool-card-model";

/** Max characters before truncation. */
const MAX_SUMMARY = 70;
const MAX_LOCATION = 30;
const MAX_QUERY = 50;
const MAX_CALENDAR = 20;

/**
 * Structured metadata embedded in calendar tool results.
 * Extracted from the `_saaleCalMeta` block appended by the tools.
 */
interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  dtStart: string;
  dtEnd?: string;
  allDay: boolean;
  calendarName: string;
  calendarColor?: string;
}

interface CalendarUpcomingMeta {
  type: "calendar_upcoming";
  from: string;
  to: string;
  count: number;
  events: CalendarEvent[];
}

interface CalendarSearchMeta {
  type: "calendar_search";
  query: string;
  count: number;
  events: CalendarEvent[];
}

type CalMeta = CalendarUpcomingMeta | CalendarSearchMeta;

/** Cards for the two read-only calendar tools. */
export const calendarToolDescriptor: ToolDescriptor = {
  names: ["calendar_upcoming", "calendar_search"],
  describe(toolCall): ToolCardModel | null {
    const meta = extractToolMeta<CalMeta>(toolCall.result);
    if (!meta) return null;

    const isSearch = meta.type === "calendar_search";
    const query = isSearch ? truncate(meta.query, MAX_QUERY) : "";

    return {
      icon: isSearch ? Search : CalendarIcon,
      title: isSearch ? "Searched calendar" : "Upcoming events",
      ...(query ? { detail: `“${query}”` } : {}),
      status: toolStatus(toolCall, plural(meta.count, "event", "events")),
      defaultOpen: true,
      blocks: [
        {
          kind: "rows",
          items: meta.events.map(eventRow),
          empty: "No events found",
        },
      ],
    };
  },
};

function eventRow(event: CalendarEvent): ToolRowModel {
  const location = event.location ? truncate(event.location, MAX_LOCATION) : "";

  return {
    leading: { kind: "icon", icon: CalendarIcon },
    title: truncate(event.summary || "(no title)", MAX_SUMMARY),
    // An event with no calendar colour gets the mission accent.
    accent: event.calendarColor || "var(--primary)",
    meta: [
      { kind: "text", text: formatEventTime(event.dtStart, event.allDay) },
      ...(location ? [{ kind: "text" as const, text: location, icon: MapPin }] : []),
      { kind: "badge", text: truncate(event.calendarName, MAX_CALENDAR) },
      ...(event.allDay ? [{ kind: "badge" as const, text: "all-day" }] : []),
      { kind: "text", text: formatRelativeStart(event.dtStart, event.allDay) },
    ],
  };
}

/** A month, day and time. or just the date for an all-day event. */
function formatEventTime(dtStart: string, allDay: boolean): string {
  const date = new Date(dtStart);
  if (isNaN(date.getTime())) return "";

  if (allDay) {
    return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/** How soon an event starts: "in 2h", "today", "tomorrow", or its date. */
function formatRelativeStart(dtStart: string, allDay: boolean): string {
  const date = new Date(dtStart);
  if (isNaN(date.getTime())) return "";

  const diffH = (date.getTime() - Date.now()) / (1000 * 60 * 60);
  const diffD = diffH / 24;

  if (allDay) {
    if (diffD < 0) return "past";
    if (diffD < 1) return "today";
    if (diffD < 2) return "tomorrow";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  if (diffH < 0) return "past";
  if (diffH < 1) return "now";
  if (diffH < 24) return `in ${Math.floor(diffH)}h`;
  if (diffD < 2) return "today";
  if (diffD < 3) return "tomorrow";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
