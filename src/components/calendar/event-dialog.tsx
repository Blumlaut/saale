"use client";

import type { CalendarEvent } from "@/types/shared";
import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, Clock, Info, Loader2, MapPin, Trash2 } from "lucide-react";
import { postJson, patchJson, deleteJson } from "@/lib/http";

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
  event: CalendarEvent | null;
  date: Date | null;
  onSuccess?: () => void;
}

export function EventDialog({
  open,
  onOpenChange,
  accounts,
  event,
  date,
  onSuccess,
}: EventDialogProps) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [dtStart, setDtStart] = useState("");
  const [dtEnd, setDtEnd] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [calendarId, setCalendarId] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

    if (event) {
      setSummary(event.summary);
      setDescription(event.description ?? "");
      setLocation(event.location ?? "");
      setDtStart(event.dtStart.substring(0, 16));
      setDtEnd(event.dtEnd ? event.dtEnd.substring(0, 16) : "");
      setAllDay(event.allDay);
      setCalendarId(event.calendarId);
    } else if (date) {
      setDtStart(date.toISOString().substring(0, 16));
      const end = new Date(date);
      end.setHours(end.getHours() + 1);
      setDtEnd(end.toISOString().substring(0, 16));
      const firstCalendar = enabledCalendars[0];
      if (firstCalendar) {
        setCalendarId(firstCalendar.id);
      }
    }
  }, [open, event, date, enabledCalendars, resetForm]);

  const handleSave = async () => {
    setSaving(true);
    setError("");

    try {
      if (event) {
        await patchJson(`/api/calendar/events/${event.id}`, {
          summary,
          description: description || null,
          location: location || null,
          dtStart: new Date(dtStart).toISOString(),
          dtEnd: dtEnd ? new Date(dtEnd).toISOString() : null,
          allDay,
        });
      } else {
        await postJson("/api/calendar/events", {
          calendarId,
          summary,
          description: description || null,
          location: location || null,
          dtStart: new Date(dtStart).toISOString(),
          dtEnd: dtEnd ? new Date(dtEnd).toISOString() : null,
          allDay,
        });
      }

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!event) return;
    setDeleting(true);
    try {
      await deleteJson(`/api/calendar/events/${event.id}`);
      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const isReadOnly = event?.source === "subscription";

  const formatDateTime = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const formatAllDayDate = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isReadOnly ? "Event Details" : event ? "Edit Event" : "New Event"}
          </DialogTitle>
        </DialogHeader>

        {/* Read-only view for subscription events */}
        {isReadOnly && event ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-dashed p-4">
              <div className="flex items-start gap-3">
                <Info className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Read-only event</p>
                  <p className="text-muted-foreground text-xs">
                    This event comes from an ICS subscription and cannot be edited directly.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <p className="text-muted-foreground text-xs">Title</p>
                <p className="mt-0.5 text-sm font-medium">{event.summary}</p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground text-xs">Start</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm">
                    <Clock className="h-3.5 w-3.5" />
                    {event.allDay ? formatAllDayDate(event.dtStart) : formatDateTime(event.dtStart)}
                  </p>
                </div>
                {event.dtEnd && (
                  <div>
                    <p className="text-muted-foreground text-xs">End</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-sm">
                      <Clock className="h-3.5 w-3.5" />
                      {event.allDay ? formatAllDayDate(event.dtEnd) : formatDateTime(event.dtEnd)}
                    </p>
                  </div>
                )}
              </div>

              {event.location && (
                <div>
                  <p className="text-muted-foreground text-xs">Location</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm">
                    <MapPin className="h-3.5 w-3.5" />
                    {event.location}
                  </p>
                </div>
              )}

              {event.description && (
                <div>
                  <p className="text-muted-foreground text-xs">Description</p>
                  <p className="mt-0.5 text-sm whitespace-pre-wrap">{event.description}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
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

            {/* Calendar (only for new events) */}
            {!event && (
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
            )}

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
            <div className="flex items-center justify-between">
              {event ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="text-destructive hover:text-destructive"
                >
                  {deleting ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  Delete
                </Button>
              ) : (
                <div />
              )}
              <Button onClick={handleSave} disabled={saving || !summary || !dtStart}>
                {saving ? "Saving..." : event ? "Save Changes" : "Create Event"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
