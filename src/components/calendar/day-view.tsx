"use client";

import type { CalendarEvent } from "@/types/shared";
import { cn } from "@/lib/utils";
import {
  getAllDayEventsForDay,
  getTimedEventsForDay,
  isSameDayUTC,
} from "@/lib/calendar/date-utils";
import { CalendarEventLabel } from "@/components/calendar/calendar-event-label";

interface DayViewProps {
  date: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick: (date: Date) => void;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function DayView({ date, events, onEventClick, onTimeSlotClick }: DayViewProps) {
  const dayEvents = getTimedEventsForDay(events, date);
  const allDayEvents = getAllDayEventsForDay(events, date);

  const today = new Date();
  const isToday = isSameDayUTC(date, today);

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

      {/* All-day events */}
      {allDayEvents.length > 0 && (
        <div className="space-y-1">
          {allDayEvents.map((evt) => (
            <CalendarEventLabel key={evt.id} event={evt} onClick={onEventClick} />
          ))}
        </div>
      )}

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
              <div
                onClick={() => {
                  const slotDate = new Date(date);
                  slotDate.setUTCHours(hour, 0, 0, 0);
                  onTimeSlotClick(slotDate);
                }}
                className="border-border/20 hover:bg-accent/60 flex-1 cursor-pointer border-t p-1 transition-colors"
              >
                {hourEvents.map((evt) => (
                  <CalendarEventLabel key={evt.id} event={evt} onClick={onEventClick} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
