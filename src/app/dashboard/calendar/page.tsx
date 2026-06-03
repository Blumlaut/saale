"use client";

import { useState, useEffect, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson } from "@/lib/http";
import { startOfWeekUTC } from "@/lib/calendar/date-utils";
import type { CalendarEvent } from "@/types/shared";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { CalendarSidebar } from "@/components/calendar/calendar-sidebar";
import { MonthView } from "@/components/calendar/month-view";
import { WeekView } from "@/components/calendar/week-view";
import { DayView } from "@/components/calendar/day-view";
import { EventDialog } from "@/components/calendar/event-dialog";

interface CalendarAccount {
  id: string;
  name: string;
  accountType: string;
  enabled: boolean;
  calendars: Array<{
    id: string;
    name: string;
    color: string | null;
    enabled: boolean;
    eventCount: number;
  }>;
}

export default function CalendarPage() {
  const [view, setView] = useState<"month" | "week" | "day">("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [accounts, setAccounts] = useState<CalendarAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchJson<{ accounts: CalendarAccount[] }>("/api/calendar/accounts");
      setAccounts(data.accounts ?? []);
    } catch {
      // Ignore
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const start = new Date(currentDate);
      let end: Date;

      if (view === "month") {
        const year = start.getUTCFullYear();
        const month = start.getUTCMonth();
        start.setTime(Date.UTC(year, month, 1));
        end = new Date(Date.UTC(year, month + 1, 0));
      } else if (view === "week") {
        const weekStart = startOfWeekUTC(start);
        end = new Date(weekStart);
        end.setUTCDate(end.getUTCDate() + 6);
      } else {
        end = new Date(start);
      }

      const enabledCalendarIds = accounts
        .flatMap((a) => a.calendars.filter((c) => c.enabled).map((c) => c.id))
        .join(",");

      const params = new URLSearchParams({
        from: start.toISOString(),
        to: end.toISOString(),
      });
      if (enabledCalendarIds) {
        params.set("calendarIds", enabledCalendarIds);
      }

      const data = await fetchJson<{ events: CalendarEvent[] }>(`/api/calendar/events?${params}`);
      setEvents(data.events ?? []);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [currentDate, view, accounts]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const navigate = (direction: -1 | 1) => {
    const next = new Date(currentDate);
    if (view === "month") {
      next.setMonth(next.getMonth() + direction);
    } else if (view === "week") {
      next.setDate(next.getDate() + direction * 7);
    } else {
      next.setDate(next.getDate() + direction);
    }
    setCurrentDate(next);
  };

  const goToToday = () => setCurrentDate(new Date());

  const handleDateClick = (date: Date) => {
    setSelectedDate(date);
    setSelectedEvent(null);
    setEventDialogOpen(true);
  };

  const handleEventClick = (event: CalendarEvent) => {
    setSelectedEvent(event);
    setSelectedDate(new Date(event.dtStart));
    setEventDialogOpen(true);
  };

  const handleEventCreated = useCallback(() => {
    loadEvents();
  }, [loadEvents]);

  const formatDateRange = () => {
    if (view === "month") {
      return currentDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    } else if (view === "week") {
      const weekStart = startOfWeekUTC(currentDate);
      const end = new Date(weekStart);
      end.setUTCDate(end.getUTCDate() + 6);
      return `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    } else {
      return currentDate.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GlassPanel className="rounded-xl p-2">
            <CalendarIcon className="text-muted-foreground h-4 w-4 md:h-5 md:w-5" />
          </GlassPanel>
          <div>
            <h1 className="text-lg font-semibold tracking-tight md:text-2xl">Calendar</h1>
            <p className="text-muted-foreground text-xs md:text-sm">
              {events.length} event{events.length !== 1 ? "s" : ""} this {view}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setSelectedDate(new Date());
            setSelectedEvent(null);
            setEventDialogOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          New Event
        </Button>
      </div>

      <div className="flex gap-4">
        {/* Sidebar */}
        <CalendarSidebar accounts={accounts} onAccountsChange={loadAccounts} />

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <GlassPanel>
            <GlassPanelContent className="space-y-4 p-4">
              {/* Toolbar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" size="sm" onClick={goToToday}>
                    Today
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => navigate(1)}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <h2 className="ml-2 text-sm font-semibold md:text-base">{formatDateRange()}</h2>
                </div>

                <Tabs value={view} onValueChange={(v) => setView(v as "month" | "week" | "day")}>
                  <TabsList className="h-7">
                    <TabsTrigger value="month" className="text-xs">
                      Month
                    </TabsTrigger>
                    <TabsTrigger value="week" className="text-xs">
                      Week
                    </TabsTrigger>
                    <TabsTrigger value="day" className="text-xs">
                      Day
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {/* View */}
              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
                </div>
              ) : view === "month" ? (
                <MonthView
                  date={currentDate}
                  events={events}
                  onDateClick={handleDateClick}
                  onEventClick={handleEventClick}
                />
              ) : view === "week" ? (
                <WeekView
                  date={currentDate}
                  events={events}
                  onEventClick={handleEventClick}
                  onTimeSlotClick={handleDateClick}
                />
              ) : (
                <DayView
                  date={currentDate}
                  events={events}
                  onEventClick={handleEventClick}
                  onTimeSlotClick={handleDateClick}
                />
              )}
            </GlassPanelContent>
          </GlassPanel>
        </div>
      </div>

      {/* Event Dialog */}
      <EventDialog
        open={eventDialogOpen}
        onOpenChange={setEventDialogOpen}
        accounts={accounts}
        event={selectedEvent}
        date={selectedDate}
        onSuccess={handleEventCreated}
      />
    </div>
  );
}
