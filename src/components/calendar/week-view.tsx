"use client";

import type { CalendarEvent } from "@/types/shared";
import { cn } from "@/lib/utils";

interface WeekViewProps {
  date: Date;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
  onTimeSlotClick: (date: Date) => void;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function WeekView({ date, events, onEventClick, onTimeSlotClick }: WeekViewProps) {
  const startOfWeek = new Date(date);
  const day = startOfWeek.getDay();
  const diff = startOfWeek.getDate() - day + (day === 0 ? -6 : 1);
  startOfWeek.setDate(diff);

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startOfWeek);
    d.setDate(d.getDate() + i);
    return d;
  });

  const today = new Date();
  const isToday = (d: Date) =>
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();

  const getEventsForDay = (d: Date) => {
    const dayTime = d.getTime();
    return events.filter((e) => {
      if (e.allDay) return false; // all-day events handled separately
      const start = new Date(e.dtStart).getTime();
      return start === dayTime;
    });
  };

  const getAllDayEventsForDay = (d: Date) => {
    const dayTime = d.getTime();
    return events.filter((e) => {
      if (!e.allDay) return false;
      const start = new Date(e.dtStart).getTime();
      const end = e.dtEnd ? new Date(e.dtEnd).getTime() : start;
      return dayTime >= start && dayTime < end;
    });
  };

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
            <span className="text-xs">{d.getDate()}</span>
          </div>
        ))}
      </div>

      {/* All-day events */}
      <div className="grid grid-cols-8">
        <div className="border-border/20 border-b" />
        {weekDays.map((d, dayIndex) => {
          const allDayEvents = getAllDayEventsForDay(d);
          return (
            <div key={dayIndex} className="border-border/20 border-b p-0.5">
              {allDayEvents.slice(0, 2).map((evt) => (
                <button
                  key={evt.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEventClick(evt);
                  }}
                  className={cn(
                    "w-full truncate rounded px-1 py-0.5 text-[10px] transition-colors hover:brightness-110",
                    "bg-primary/10 text-primary",
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
                  {evt.summary}
                </button>
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
              const dayEvents = getEventsForDay(d);
              const hourEvents = dayEvents.filter((e) => {
                const startHour = new Date(e.dtStart).getHours();
                return startHour === hour;
              });

              return (
                <button
                  key={dayIndex}
                  onClick={() => {
                    const slotDate = new Date(d);
                    slotDate.setHours(hour, 0, 0, 0);
                    onTimeSlotClick(slotDate);
                  }}
                  className="border-border/20 border-t p-0.5 transition-colors hover:bg-white/10"
                >
                  {hourEvents.map((evt) => (
                    <button
                      key={evt.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onEventClick(evt);
                      }}
                      className={cn(
                        "w-full truncate rounded px-1 py-0.5 text-[10px] transition-colors hover:brightness-110",
                        "bg-primary/10 text-primary",
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
                      {evt.summary}
                    </button>
                  ))}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
