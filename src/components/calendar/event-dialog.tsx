"use client";

import { useState, useEffect, useCallback } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, MapPin } from "lucide-react";
import { postJson } from "@/lib/http";

interface CalendarAccount {
  id: string;
  name: string;
  enabled: boolean;
  calendars: Array<{
    id: string;
    name: string;
    color: string | null;
    enabled: boolean;
  }>;
}

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: CalendarAccount[];
  date: Date | null;
  onSuccess?: () => void;
}

export function EventDialog({ open, onOpenChange, accounts, date, onSuccess }: EventDialogProps) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [dtStart, setDtStart] = useState("");
  const [dtEnd, setDtEnd] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [calendarId, setCalendarId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const enabledCalendars = accounts
    .flatMap((a) => a.calendars.filter((c) => c.enabled))
    .sort((a, b) => a.name.localeCompare(b.name));

  const resetForm = useCallback(() => {
    setSummary("");
    setDescription("");
    setLocation("");
    setDtStart("");
    setDtEnd("");
    setAllDay(false);
    setCalendarId("");
    setError("");
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
      return;
    }

    if (date) {
      setDtStart(date.toISOString().substring(0, 16));
      const end = new Date(date);
      end.setHours(end.getHours() + 1);
      setDtEnd(end.toISOString().substring(0, 16));
      const firstCalendar = enabledCalendars[0];
      if (firstCalendar) {
        setCalendarId(firstCalendar.id);
      }
    }
  }, [open, date, enabledCalendars, resetForm]);

  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      await postJson("/api/calendar/events", {
        calendarId,
        summary,
        description: description || null,
        location: location || null,
        dtStart: new Date(dtStart).toISOString(),
        dtEnd: dtEnd ? new Date(dtEnd).toISOString() : null,
        allDay,
      });

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="liquid-glass flex w-[440px] flex-col overflow-hidden border-0 bg-transparent p-0 shadow-2xl sm:max-w-none">
        <div className="flex h-full flex-col">
          {/* Header */}
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              New Event
            </SheetTitle>
          </SheetHeader>

          {/* Scrollable form */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-4">
              {/* Title */}
              <div className="space-y-2">
                <Label className="text-xs">Title</Label>
                <Input
                  className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
                  placeholder="Meeting title"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </div>

              {/* Calendar */}
              <div className="space-y-2">
                <Label className="text-xs">Calendar</Label>
                <div className="liquid-glass-inner rounded-2xl border-0 bg-transparent px-2 py-1 shadow-none">
                  <select
                    className="border-border w-full rounded-full border bg-transparent px-3 py-2 text-sm focus-visible:outline-none"
                    value={calendarId}
                    onChange={(e) => setCalendarId(e.target.value)}
                  >
                    {enabledCalendars.map((cal) => (
                      <option key={cal.id} value={cal.id}>
                        {cal.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Date/Time */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs">Start</Label>
                  <Input
                    className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
                    type={allDay ? "date" : "datetime-local"}
                    value={dtStart}
                    onChange={(e) => setDtStart(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">End</Label>
                  <Input
                    className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
                    type={allDay ? "date" : "datetime-local"}
                    value={dtEnd}
                    onChange={(e) => setDtEnd(e.target.value)}
                  />
                </div>
              </div>

              {/* All day toggle */}
              <div className="liquid-glass-inner flex items-center justify-between rounded-2xl px-4 py-3">
                <Label htmlFor="all-day" className="text-sm">
                  All day
                </Label>
                <Switch checked={allDay} id="all-day" onCheckedChange={setAllDay} />
              </div>

              {/* Location */}
              <div className="space-y-2">
                <Label className="text-xs">
                  <MapPin className="mr-1 inline h-3 w-3" />
                  Location
                </Label>
                <Input
                  className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
                  placeholder="Room, address, or video link"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label className="text-xs">Description</Label>
                <Textarea
                  className="liquid-glass-inner min-h-[80px] rounded-2xl border-0 bg-transparent px-4 pt-3 shadow-none"
                  placeholder="Notes, agenda, etc."
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              {/* Error */}
              {error && (
                <div className="liquid-glass-destructive flex items-center gap-2 rounded-2xl px-4 py-3">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span className="text-xs">{error}</span>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="border-border/30 border-t px-6 py-4">
            <Button
              className="liquid-glass-accent h-9 w-full rounded-full text-xs font-medium"
              disabled={saving || !summary || !dtStart}
              onClick={handleSave}
            >
              {saving ? "Creating..." : "Create Event"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
