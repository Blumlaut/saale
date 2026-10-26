"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import type { CalendarAccountCalendar } from "@/types/shared";

interface CalendarsExpandableProps {
  calendars: CalendarAccountCalendar[];
  isExpanded: boolean;
  onToggle: () => void;
}

export function CalendarsExpandable({ calendars, isExpanded, onToggle }: CalendarsExpandableProps) {
  if (calendars.length === 0) return null;

  return (
    <div className="border-border/50 border-t">
      <button
        className="hover:bg-accent/60 flex w-full items-center gap-2 px-4 py-2 text-xs transition-colors"
        onClick={onToggle}
      >
        {isExpanded ? (
          <ChevronDown className="text-muted-foreground h-3 w-3" />
        ) : (
          <ChevronRight className="text-muted-foreground h-3 w-3" />
        )}
        <span className="text-muted-foreground">
          {isExpanded ? "Hide" : "Show"} {calendars.length} calendar
          {calendars.length !== 1 ? "s" : ""}
        </span>
      </button>

      {isExpanded && (
        <div className="border-border/50 border-t px-4 py-2">
          {calendars.map((cal) => (
            <div key={cal.id} className="flex items-center gap-2 py-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: cal.color || "var(--muted-foreground)",
                }}
              />
              <span className="text-xs">{cal.name}</span>
              <span className="text-muted-foreground/60 text-[10px]">{cal.eventCount} events</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
