"use client";

import type { CalendarEvent } from "@/types/shared";
import { cn } from "@/lib/utils";
import { getEventsForDay } from "@/lib/calendar/date-utils";
import { Badge } from "@/components/ui/badge";

interface MonthViewProps {
  date: Date;
  events: CalendarEvent[];
  onDateClick: (date: Date) => void;
  onEventClick: (event: CalendarEvent) => void;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthView({ date, events, onDateClick, onEventClick }: MonthViewProps) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startDay = (firstDay.getDay() + 6) % 7; // Monday start

  const days: Array<{ date: Date; isCurrentMonth: boolean }> = [];

  // Previous month days
  for (let i = startDay - 1; i >= 0; i--) {
    const d = new Date(year, month, -i);
    days.push({ date: d, isCurrentMonth: false });
  }

  // Current month days
  for (let i = 1; i <= lastDay.getDate(); i++) {
    days.push({ date: new Date(year, month, i), isCurrentMonth: true });
  }

  // Next month days
  while (days.length % 7 !== 0) {
    const d = new Date(year, month + 1, days.length - startDay - lastDay.getDate() + 1);
    days.push({ date: d, isCurrentMonth: false });
  }

  const today = new Date();
  const isToday = (d: Date) =>
    d.getDate() === today.getDate() &&
    d.getMonth() === today.getMonth() &&
    d.getFullYear() === today.getFullYear();

  return (
    <div className="space-y-2">
      {/* Day headers */}
      <div className="grid grid-cols-7">
        {DAYS.map((day) => (
          <div key={day} className="text-muted-foreground py-1 text-center text-xs font-medium">
            {day}
          </div>
        ))}
      </div>

      {/* Days grid */}
      <div className="border-border/50 grid grid-cols-7 overflow-hidden rounded-xl border">
        {days.map(({ date: day, isCurrentMonth }, index) => {
          const dayEvents = getEventsForDay(events, day);
          const isTodayDate = isToday(day);

          return (
            <button
              key={index}
              onClick={() => onDateClick(day)}
              className={cn(
                "border-border/30 min-h-[80px] border-r border-b p-1 text-left transition-colors hover:bg-white/10",
                !isCurrentMonth && "bg-muted/20 text-muted-foreground",
                isTodayDate && "bg-primary/5",
                index % 7 === 6 && "border-r-0",
                index >= days.length - 7 && "border-b-0",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full text-xs",
                  isTodayDate && "bg-primary text-primary-foreground font-semibold",
                  !isCurrentMonth && "text-muted-foreground/50",
                )}
              >
                {day.getDate()}
              </span>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {dayEvents.slice(0, 3).map((evt) => (
                  <button
                    key={evt.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEventClick(evt);
                    }}
                    className={cn(
                      "truncate rounded px-1 py-0.5 text-[10px] transition-colors hover:brightness-110",
                      evt.allDay
                        ? "bg-primary/10 text-primary"
                        : "bg-muted/40 text-muted-foreground",
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
                {dayEvents.length > 3 && (
                  <Badge
                    variant="secondary"
                    className="self-start rounded-full px-1 py-0 text-[9px]"
                  >
                    +{dayEvents.length - 3} more
                  </Badge>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
