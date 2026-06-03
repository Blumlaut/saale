"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New Event</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Summary */}
          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Meeting title"
            />
          </div>

          {/* Calendar */}
          <div className="space-y-2">
            <Label>Calendar</Label>
            <select
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              className="border-input focus-visible:ring-ring flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
            >
              {enabledCalendars.map((cal) => (
                <option key={cal.id} value={cal.id}>
                  {cal.name}
                </option>
              ))}
            </select>
          </div>

          {/* Date/Time */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Start</Label>
              <Input
                type={allDay ? "date" : "datetime-local"}
                value={dtStart}
                onChange={(e) => setDtStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>End</Label>
              <Input
                type={allDay ? "date" : "datetime-local"}
                value={dtEnd}
                onChange={(e) => setDtEnd(e.target.value)}
              />
            </div>
          </div>

          {/* All day toggle */}
          <div className="flex items-center gap-2">
            <Switch checked={allDay} onCheckedChange={setAllDay} id="all-day" />
            <Label htmlFor="all-day" className="text-sm">
              All day
            </Label>
          </div>

          {/* Location */}
          <div className="space-y-2">
            <Label>
              <MapPin className="mr-1 inline h-3 w-3" />
              Location
            </Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Room, address, or video link"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Notes, agenda, etc."
              rows={3}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving || !summary || !dtStart}>
              {saving ? "Creating..." : "Create Event"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
