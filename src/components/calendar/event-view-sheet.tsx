"use client";

import type { CalendarEvent } from "@/types/shared";
import { useState, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  AlertCircle,
  Calendar as CalendarIcon,
  Clock,
  Info,
  Loader2,
  MapPin,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { patchJson, deleteJson } from "@/lib/http";

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

interface EventViewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: CalendarAccount[];
  event: CalendarEvent | null;
  onSuccess?: () => void;
}

export function EventViewSheet({
  open,
  onOpenChange,
  accounts: _accounts,
  event,
  onSuccess,
}: EventViewSheetProps) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [dtStart, setDtStart] = useState("");
  const [dtEnd, setDtEnd] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const isReadOnly = event?.source === "subscription";

  const resetToView = useCallback(() => {
    setMode("view");
    setError("");
  }, []);

  useEffect(() => {
    if (!open) {
      resetToView();
      return;
    }

    if (event) {
      setSummary(event.summary);
      setDescription(event.description ?? "");
      setLocation(event.location ?? "");
      setDtStart(event.dtStart.substring(0, 16));
      setDtEnd(event.dtEnd ? event.dtEnd.substring(0, 16) : "");
      setAllDay(event.allDay);
    }
  }, [open, event, resetToView]);

  const handleSave = async () => {
    if (!event) return;
    setSaving(true);
    setError("");

    try {
      await patchJson(`/api/calendar/events/${event.id}`, {
        summary,
        description: description || null,
        location: location || null,
        dtStart: new Date(dtStart).toISOString(),
        dtEnd: dtEnd ? new Date(dtEnd).toISOString() : null,
        allDay,
      });

      setMode("view");
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
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

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

  const formatDuration = () => {
    if (!event) return "";
    const start = new Date(event.dtStart);
    const end = event.dtEnd ? new Date(event.dtEnd) : null;
    if (event.allDay) {
      if (end) {
        const diffDays = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
        return `${diffDays} day${diffDays > 1 ? "s" : ""}`;
      }
      return "1 day";
    }
    if (end) {
      const diffMs = end.getTime() - start.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.round((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      if (diffHours > 0 && diffMins > 0) {
        return `${diffHours}h ${diffMins}m`;
      }
      if (diffHours > 0) return `${diffHours}h`;
      return `${diffMins}m`;
    }
    return "";
  };

  if (!event) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="border-l border-white/20 bg-white/80 backdrop-blur-2xl sm:w-[440px] dark:border-white/10 dark:bg-black/40">
        {mode === "view" ? (
          <>
            {/* Close button */}
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 right-4"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </Button>

            <SheetHeader className="pr-10">
              <SheetTitle className="text-lg leading-tight">{event.summary}</SheetTitle>
              <SheetDescription className="line-clamp-2 pt-1">
                {event.calendarName}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 flex flex-col gap-5 overflow-y-auto">
              {/* Read-only notice */}
              {isReadOnly && (
                <div className="rounded-2xl border border-dashed p-3">
                  <div className="flex items-start gap-2.5">
                    <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      This event comes from an ICS subscription and cannot be edited directly.
                    </p>
                  </div>
                </div>
              )}

              {/* Date & time */}
              <div className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <CalendarIcon className="text-muted-foreground h-4 w-4" />
                  <span className="text-sm">
                    {event.allDay ? formatAllDayDate(event.dtStart) : formatDateTime(event.dtStart)}
                  </span>
                </div>
                {event.dtEnd && (
                  <div className="flex items-center gap-2">
                    <Clock className="text-muted-foreground h-4 w-4" />
                    <span className="text-muted-foreground text-sm">
                      {event.allDay ? formatAllDayDate(event.dtEnd) : formatDateTime(event.dtEnd)} ·{" "}
                      {formatDuration()}
                    </span>
                  </div>
                )}
              </div>

              <Separator />

              {/* Location */}
              {event.location && (
                <div className="flex items-start gap-2.5">
                  <MapPin className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                  <span className="text-sm">{event.location}</span>
                </div>
              )}

              {/* Description */}
              {event.description && (
                <div className="space-y-1.5">
                  <p className="text-muted-foreground text-xs">Description</p>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{event.description}</p>
                </div>
              )}

              {/* Spacer */}
              <div className="flex-1" />

              {/* Actions */}
              <div className="flex items-center gap-2">
                {!isReadOnly && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={handleDelete}
                      disabled={deleting}
                    >
                      {deleting ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                      )}
                      Delete
                    </Button>
                    <Button size="sm" onClick={() => setMode("edit")}>
                      <Pencil className="mr-2 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </>
                )}
                {isReadOnly && (
                  <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                    Close
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Edit mode */}
            <SheetHeader className="gap-1">
              <div className="flex items-center justify-between">
                <SheetTitle>Edit Event</SheetTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setMode("view")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </SheetHeader>

            <div className="mt-4 flex flex-col gap-4 overflow-y-auto">
              {/* Summary */}
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="Meeting title"
                />
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

              {/* Spacer */}
              <div className="flex-1" />

              {/* Actions */}
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => setMode("view")}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving || !summary || !dtStart}>
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
