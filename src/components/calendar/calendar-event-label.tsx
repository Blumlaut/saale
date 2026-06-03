"use client";

import type { CalendarEvent } from "@/types/shared";
import { cn } from "@/lib/utils";

interface CalendarEventLabelProps {
  event: CalendarEvent;
  onClick?: (event: CalendarEvent) => void;
  /** When true, the click stops propagation to prevent parent handlers from firing. */
  stopPropagation?: boolean;
  /** Compact mode (month/week view). Omit extra details like location. */
  compact?: boolean;
  children?: React.ReactNode;
}

export function CalendarEventLabel({
  event,
  onClick,
  stopPropagation = true,
  compact = false,
  children,
}: CalendarEventLabelProps) {
  const handleClick = (e: React.MouseEvent) => {
    if (stopPropagation) {
      e.stopPropagation();
    }
    onClick?.(event);
  };

  const colorStyle = event.calendarColor
    ? {
        backgroundColor: event.calendarColor + "20",
        color: event.calendarColor,
      }
    : undefined;

  if (children) {
    return (
      <span
        onClick={handleClick}
        className={cn(
          "block w-full cursor-pointer truncate rounded px-1 py-0.5 text-[10px] transition-colors hover:brightness-110",
          "bg-primary/10 text-primary",
        )}
        style={colorStyle}
      >
        {children}
      </span>
    );
  }

  if (compact) {
    return (
      <span
        onClick={handleClick}
        className={cn(
          "cursor-pointer truncate rounded px-1 py-0.5 text-[10px] transition-colors hover:brightness-110",
          event.allDay ? "bg-primary/10 text-primary" : "bg-muted/40 text-muted-foreground",
        )}
        style={colorStyle}
      >
        {event.summary}
      </span>
    );
  }

  return (
    <span
      onClick={handleClick}
      className={cn(
        "block w-full cursor-pointer rounded-lg p-2 text-left transition-colors hover:brightness-110",
        "bg-primary/10",
      )}
      style={colorStyle}
    >
      <div className="text-xs font-medium">{event.summary}</div>
      {event.location && <div className="text-muted-foreground text-[10px]">{event.location}</div>}
    </span>
  );
}
