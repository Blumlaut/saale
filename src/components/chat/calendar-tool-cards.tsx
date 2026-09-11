"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Calendar as CalendarIcon,
  Search,
  MapPin,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { useState, useMemo } from "react";
import type { ToolCallData } from "./types";

/** Max characters before truncation. */
const MAX_SUMMARY = 70;
const MAX_LOCATION = 30;
const MAX_QUERY = 50;
const MAX_CALENDAR_NAME = 20;

/**
 * Structured metadata embedded in calendar tool results.
 */
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

type CalMeta = CalendarUpcomingMeta | CalendarSearchMeta;

/**
 * Extract _saaleCalMeta from a tool result string.
 */
function extractCalMeta(result: string | undefined): CalMeta | null {
  if (!result) return null;

  const looseIdx = result.lastIndexOf('"_saaleCalMeta"');
  if (looseIdx === -1) return null;

  const openBrace = result.lastIndexOf("{", looseIdx);
  if (openBrace === -1) return null;

  let depth = 0;
  let closeBrace = -1;
  for (let i = openBrace; i < result.length; i++) {
    if (result[i] === "{") depth++;
    else if (result[i] === "}") {
      depth--;
      if (depth === 0) {
        closeBrace = i;
        break;
      }
    }
  }
  if (closeBrace === -1) return null;

  try {
    return JSON.parse(result.slice(openBrace, closeBrace + 1))._saaleCalMeta as CalMeta;
  } catch {
    return null;
  }
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(str: string, max: number): string {
  if (!str) return "";
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

/**
 * Format a datetime for display.
 */
function formatEventTime(dtStart: string, allDay: boolean): string {
  if (allDay) {
    try {
      return new Date(dtStart).toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    } catch {
      return "";
    }
  }
  try {
    return new Date(dtStart).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

/**
 * Format a relative time range ("in 2h", "today", "tomorrow").
 */
function formatRelativeStart(dtStart: string, allDay: boolean): string {
  try {
    const date = new Date(dtStart);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffH = diffMs / (1000 * 60 * 60);
    const diffD = diffMs / (1000 * 60 * 60 * 24);

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
  } catch {
    return "";
  }
}

/**
 * Single event row.
 */
function EventRow({ event }: { event: CalendarEvent }) {
  const summary = truncate(event.summary || "(no title)", MAX_SUMMARY);
  const location = truncate(event.location || "", MAX_LOCATION);
  const time = formatEventTime(event.dtStart, event.allDay);
  const relative = formatRelativeStart(event.dtStart, event.allDay);
  const calendarName = truncate(event.calendarName, MAX_CALENDAR_NAME);

  return (
    <div
      className={cn(
        "group hover:bg-accent/60 flex items-start gap-2.5 rounded-lg border-l-2 px-2.5 py-2 transition-colors",
        event.calendarColor ? "" : "border-l-blue-500",
      )}
      style={event.calendarColor ? { borderLeftColor: event.calendarColor } : undefined}
    >
      <CalendarIcon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />

      <div className="min-w-0 flex-1">
        <p className="text-foreground/90 truncate text-xs font-medium">{summary}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-muted-foreground/70 text-[11px]">{time}</span>
          {location && (
            <span className="text-muted-foreground/60 flex items-center gap-0.5 text-[10px]">
              <MapPin className="h-2.5 w-2.5" />
              {location}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
            {calendarName}
          </Badge>
          {event.allDay && (
            <Badge variant="secondary" className="rounded px-1 py-0 text-[10px] font-normal">
              all-day
            </Badge>
          )}
          <span className="text-muted-foreground/50 text-[10px]">{relative}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Calendar card (upcoming or search).
 */
export function CalendarToolCard({ toolCall }: { toolCall: ToolCallData }) {
  const meta = useMemo(() => extractCalMeta(toolCall.result), [toolCall.result]);
  const [expanded, setExpanded] = useState(false);

  if (!meta) return null;

  const isSearch = meta.type === "calendar_search";
  const displayQuery = isSearch ? truncate(meta.query, MAX_QUERY) : null;
  const maxVisible = 3;
  const visibleEvents = meta.events.slice(0, expanded ? meta.events.length : maxVisible);
  const hasMore = meta.events.length > maxVisible;

  return (
    <div className="liquid-glass-inner rounded-xl">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        {isSearch ? (
          <Search className="text-muted-foreground h-3 w-3" />
        ) : (
          <CalendarIcon className="text-muted-foreground h-3 w-3" />
        )}
        <span className="text-xs font-medium">
          {isSearch ? "Searched calendar" : "Upcoming events"}
        </span>
        {displayQuery && (
          <span className="text-muted-foreground truncate text-xs">
            &ldquo;{displayQuery}&rdquo;
          </span>
        )}
        <Badge
          variant="secondary"
          className={cn(
            "ml-auto rounded-full px-1.5 py-0 text-[10px]",
            toolCall.status === "running" && "bg-yellow-500/10 text-yellow-600",
            toolCall.status === "completed" && "bg-green-500/10 text-green-600",
            (toolCall.status === "error" || toolCall.error) && "bg-red-500/10 text-red-600",
          )}
        >
          {toolCall.status === "running" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
          {toolCall.status === "completed" && <CalendarIcon className="mr-1 h-2.5 w-2.5" />}
          {(toolCall.status === "error" || toolCall.error) && (
            <AlertCircle className="mr-1 h-2.5 w-2.5" />
          )}
          {meta.count} event{meta.count !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Event rows */}
      {meta.events.length > 0 ? (
        <div className="border-border/30 border-t px-1.5 py-1">
          <div className="space-y-0.5">
            {visibleEvents.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>

          {hasMore && !expanded && (
            <button
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronDown className="h-3 w-3" />
              Show {meta.events.length - maxVisible} more
            </button>
          )}

          {hasMore && expanded && (
            <button
              onClick={() => setExpanded(false)}
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1 pt-1.5 text-xs"
            >
              <ChevronRight className="h-3 w-3" />
              Show less
            </button>
          )}
        </div>
      ) : (
        <div className="border-border/30 border-t px-3 py-2.5">
          <p className="text-muted-foreground text-xs">No events found</p>
        </div>
      )}
    </div>
  );
}
