"use client";

import type { CalendarEvent } from "@/types/shared";
import { cn } from "@/lib/utils";
import {
  getWeekDaysUTC,
  getAllDayEventsForDay,
  getTimedEventsForDay,
  isSameDayUTC,
} from "@/lib/calendar/date-utils";
import { CalendarEventLabel } from "@/components/calendar/calendar-event-label";

interface WeekViewProps {
  date: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick: (date: Date) => void;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function WeekView({ date, events, onEventClick, onTimeSlotClick }: WeekViewProps) {
  const weekDays = getWeekDaysUTC(date);
  const today = new Date();
  const isToday = (d: Date) => isSameDayUTC(d, today);

  return (
    <div className="space-y-2">
      {/* Day headers */}
      <div className="grid grid-cols-8">
        <div className="h-8" />
        {weekDays.map((d, i) => (
          <div
            key={i}
            className={cn(
              "flex flex-col items-center py-1 text-center",
              isToday(d) && "text-primary font-semibold",
            )}
          >
            <span className="text-muted-foreground text-[10px]">{DAYS[i]}</span>
            <span className="text-xs">{d.getUTCDate()}</span>
          </div>
        ))}
      </div>

      {/* All-day events */}
      <div className="grid grid-cols-8">
        <div className="border-border/20 border-b" />
        {weekDays.map((d, dayIndex) => {
          const allDayEvents = getAllDayEventsForDay(events, d);
          return (
            <div key={dayIndex} className="border-border/20 border-b p-0.5">
              {allDayEvents.slice(0, 2).map((evt) => (
                <CalendarEventLabel key={evt.id} event={evt} onClick={onEventClick} />
              ))}
            </div>
          );
        })}
      </div>

      {/* Time grid */}
      <div className="max-h-[600px] overflow-y-auto">
        {HOURS.map((hour) => (
          <div key={hour} className="grid grid-cols-8">
            <div className="text-muted-foreground pr-2 text-right text-[10px]">
              {hour === 0
                ? "12 AM"
                : hour < 12
                  ? `${hour} AM`
                  : hour === 12
                    ? "12 PM"
                    : `${hour - 12} PM`}
            </div>
            {weekDays.map((d, dayIndex) => {
              const hourEvents = getTimedEventsForDay(events, d).filter((e) => {
                const startHour = new Date(e.dtStart).getHours();
                return startHour === hour;
              });

              return (
                <div
                  key={dayIndex}
                  className="border-border/20 cursor-pointer border-t p-0.5 transition-colors hover:bg-white/10"
                  onClick={() => {
                    const slotDate = new Date(d);
                    slotDate.setUTCHours(hour, 0, 0, 0);
                    onTimeSlotClick(slotDate);
                  }}
                >
                  {hourEvents.map((evt) => (
                    <CalendarEventLabel key={evt.id} event={evt} onClick={onEventClick} />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
