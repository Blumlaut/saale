"use client";

import { useState, useEffect, useCallback } from "react";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson } from "@/lib/http";
import { oneOf, usePersistedState } from "@/hooks/use-persisted-state";
import { startOfWeekUTC } from "@/lib/calendar/date-utils";
import type { CalendarEvent } from "@/types/shared";
import type { CalendarAccountSummary } from "@/types/shared";
import { Page, PageAction, PageScroll } from "@/components/layout/page";
import { ChevronLeft, ChevronRight, Loader2, Plus } from "lucide-react";
import { CalendarSidebar } from "@/components/calendar/calendar-sidebar";
import { MonthView } from "@/components/calendar/month-view";
import { WeekView } from "@/components/calendar/week-view";
import { DayView } from "@/components/calendar/day-view";
import { EventDialog } from "@/components/calendar/event-dialog";
import { EventViewSheet } from "@/components/calendar/event-view-sheet";

export default function CalendarPage() {
  const [view, setView, viewRestored] = usePersistedState<"month" | "week" | "day">(
    "calendar:view",
    "month",
    { validate: oneOf("month", "week", "day") },
  );
  const [currentDate, setCurrentDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [accounts, setAccounts] = useState<CalendarAccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [viewSheetOpen, setViewSheetOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  const loadAccounts = useCallback(async () => {
    try {
      const data = await fetchJson<{ accounts: CalendarAccountSummary[] }>(
        "/api/calendar/accounts",
      );
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
        end = new Date(Date.UTC(year, month + 1, 1)); // first day of next month
      } else if (view === "week") {
        const weekStart = startOfWeekUTC(start);
        end = new Date(weekStart);
        end.setUTCDate(end.getUTCDate() + 7); // Sunday end of day
      } else {
        // Day view: midnight to end of day
        const year = start.getUTCFullYear();
        const month = start.getUTCMonth();
        const day = start.getUTCDate();
        start.setTime(Date.UTC(year, month, day));
        end = new Date(Date.UTC(year, month, day + 1));
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
    if (!viewRestored) return;
    loadEvents();
  }, [loadEvents, viewRestored]);

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
    setCreateDialogOpen(true);
  };

  const handleEventClick = (event: CalendarEvent) => {
    setSelectedEvent(event);
    setSelectedDate(null);
    setViewSheetOpen(true);
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
    <Page>
      {/* Sidebar + calendar. scrolls internally */}
      <PageScroll>
        <div className="flex flex-col gap-4 md:flex-row">
          <CalendarSidebar accounts={accounts} onAccountsChange={loadAccounts} />

          {/* Main content */}
          <div className="min-w-0 flex-1">
            <GlassPanel>
              <GlassPanelContent className="space-y-4 p-4">
                {/* Toolbar. two rows on narrow screens, one on md+ */}
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={goToToday}>
                      Today
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => navigate(1)}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <h2 className="min-w-0 truncate text-sm font-semibold md:text-base">
                      {formatDateRange()}
                    </h2>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Tabs
                      value={view}
                      onValueChange={(v) => setView(v as "month" | "week" | "day")}
                    >
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
                    <PageAction
                      icon={Plus}
                      label="New Event"
                      onClick={() => {
                        setSelectedDate(new Date());
                        setCreateDialogOpen(true);
                      }}
                    />
                  </div>
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
      </PageScroll>

      {/* View Event Sheet */}
      <EventViewSheet
        open={viewSheetOpen}
        onOpenChange={setViewSheetOpen}
        accounts={accounts}
        event={selectedEvent}
        onSuccess={handleEventCreated}
      />

      {/* Create Event Dialog */}
      <EventDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        accounts={accounts}
        date={selectedDate}
        onSuccess={handleEventCreated}
      />
    </Page>
  );
}
