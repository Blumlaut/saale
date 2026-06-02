"use client";

import type { CalendarEvent } from "@/types/shared";
import { cn } from "@/lib/utils";

interface DayViewProps {
  date: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick: (date: Date) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function DayView({ date, events, onEventClick, onTimeSlotClick }: DayViewProps) {
  const dayStr = date.toDateString();
  const dayEvents = events.filter(
    (e) => new Date(e.dtStart).toDateString() === dayStr && !e.allDay,
  );

  const today = new Date();
  const isToday =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();

  return (
    <div className="space-y-2">
      {/* Date header */}
      <div className="text-center">
        <span className={cn("text-sm font-medium", isToday && "text-primary")}>
          {date.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </span>
        {isToday && <span className="text-muted-foreground ml-2 text-xs">(Today)</span>}
      </div>

      {/* Time grid */}
      <div className="max-h-[600px] overflow-y-auto">
        {HOURS.map((hour) => {
          const hourEvents = dayEvents.filter((e) => {
            const startHour = new Date(e.dtStart).getHours();
            return startHour === hour;
          });

          return (
            <div key={hour} className="flex gap-2">
              <div className="text-muted-foreground w-16 shrink-0 text-right text-[10px]">
                {hour === 0
                  ? "12 AM"
                  : hour < 12
                    ? `${hour} AM`
                    : hour === 12
                      ? "12 PM"
                      : `${hour - 12} PM`}
              </div>
              <button
                onClick={() => {
                  const slotDate = new Date(date);
                  slotDate.setHours(hour, 0, 0, 0);
                  onTimeSlotClick(slotDate);
                }}
                className="border-border/20 flex-1 border-t p-1 transition-colors hover:bg-white/10"
              >
                {hourEvents.map((evt) => (
                  <button
                    key={evt.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(evt);
                    }}
                    className={cn(
                      "w-full rounded-lg p-2 text-left transition-colors hover:brightness-110",
                      "bg-primary/10",
                    )}
                    style={
                      evt.calendarColor
                        ? {
                            backgroundColor: evt.calendarColor + "20",
                            color: evt.calendarColor,
                          }
                        : undefined
                    }
                  >
                    <div className="text-xs font-medium">{evt.summary}</div>
                    {evt.location && (
                      <div className="text-muted-foreground text-[10px]">{evt.location}</div>
                    )}
                  </button>
                ))}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
