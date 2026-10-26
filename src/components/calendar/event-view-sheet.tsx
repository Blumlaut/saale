"use client";

import type { CalendarAccountSummary, CalendarEvent } from "@/types/shared";
import { useState, useEffect, useCallback } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  Calendar as CalendarIcon,
  Clock,
  Info,
  Loader2,
  MapPin,
  Pencil,
  Trash2,
} from "lucide-react";
import { patchJson, deleteJson } from "@/lib/http";
import { draftFromEvent, EMPTY_EVENT_DRAFT, eventDraftPayload } from "@/lib/calendar/event-draft";
import type { EventDraft } from "@/lib/calendar/event-draft";
import { EventFormFields } from "@/components/calendar/event-form-fields";

interface EventViewSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: CalendarAccountSummary[];
  event: CalendarEvent | null;
  onSuccess?: () => void;
}

export function EventViewSheet({ open, onOpenChange, event, onSuccess }: EventViewSheetProps) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<EventDraft>(EMPTY_EVENT_DRAFT);
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

    if (event) setDraft(draftFromEvent(event));
  }, [open, event, resetToView]);

  const handleSave = async () => {
    if (!event) return;
    setSaving(true);
    setError("");

    try {
      await patchJson(`/api/calendar/events/${event.id}`, eventDraftPayload(draft));

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
      <SheetContent
        showCloseButton
        className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none dark:sm:w-[460px]"
      >
        {mode === "view" ? (
          <div className="flex h-full flex-col">
            {/* Header */}
            <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
              <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
                {event.summary}
              </SheetTitle>
              <p className="text-muted-foreground mt-1 text-xs">{event.calendarName}</p>
            </SheetHeader>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {/* Read-only notice */}
              {isReadOnly && (
                <div className="liquid-glass-inner mb-5 flex items-start gap-3 rounded-2xl px-4 py-3.5">
                  <Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    This event comes from an ICS subscription and cannot be edited directly.
                  </p>
                </div>
              )}

              {/* Date & time block */}
              <div className="liquid-glass-inner rounded-2xl px-4 py-4">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="liquid-glass-pill flex h-8 w-8 items-center justify-center rounded-full">
                      <CalendarIcon className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Start</p>
                      <p className="text-sm font-medium">
                        {event.allDay
                          ? formatAllDayDate(event.dtStart)
                          : formatDateTime(event.dtStart)}
                      </p>
                    </div>
                  </div>
                  {event.dtEnd && (
                    <div className="flex items-center gap-3">
                      <div className="liquid-glass-pill flex h-8 w-8 items-center justify-center rounded-full">
                        <Clock className="h-3.5 w-3.5" />
                      </div>
                      <div>
                        <p className="text-muted-foreground text-xs">End</p>
                        <p className="text-sm">
                          {event.allDay
                            ? formatAllDayDate(event.dtEnd)
                            : formatDateTime(event.dtEnd)}
                        </p>
                        <p className="text-muted-foreground text-xs">{formatDuration()}</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Location */}
              {event.location && (
                <div className="liquid-glass-inner mt-4 rounded-2xl px-4 py-3.5">
                  <div className="flex items-start gap-3">
                    <div className="liquid-glass-pill flex h-8 w-8 items-center justify-center rounded-full">
                      <MapPin className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Location</p>
                      <p className="text-sm">{event.location}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Description */}
              {event.description && (
                <div className="liquid-glass-inner mt-4 rounded-2xl px-4 py-3.5">
                  <p className="text-muted-foreground text-xs">Description</p>
                  <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap">
                    {event.description}
                  </p>
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="border-border/30 border-t px-6 py-4">
              <div className="flex items-center gap-2">
                {!isReadOnly && (
                  <>
                    <Button
                      className="liquid-glass-destructive h-9 flex-1 rounded-full text-xs font-medium"
                      onClick={handleDelete}
                      disabled={deleting}
                      variant="ghost"
                    >
                      {deleting ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Delete
                    </Button>
                    <Button
                      className="liquid-glass-accent h-9 flex-1 rounded-full text-xs font-medium"
                      onClick={() => setMode("edit")}
                    >
                      <Pencil className="mr-1.5 h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </>
                )}
                {isReadOnly && (
                  <Button
                    className="liquid-glass-pill h-9 w-full rounded-full text-xs font-medium"
                    onClick={() => onOpenChange(false)}
                    variant="ghost"
                  >
                    Close
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {/* Edit header */}
            <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
              <div className="flex items-center justify-between">
                <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
                  Edit Event
                </SheetTitle>
                <Button
                  className="liquid-glass-pill h-8 w-8 rounded-full p-0"
                  onClick={() => setMode("view")}
                  size="icon"
                  variant="ghost"
                >
                  <span className="text-sm">Done</span>
                </Button>
              </div>
            </SheetHeader>

            {/* Edit form */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <EventFormFields
                draft={draft}
                onFieldChange={(key, value) =>
                  setDraft((current) => ({ ...current, [key]: value }))
                }
                error={error}
              />
            </div>

            {/* Edit footer */}
            <div className="border-border/30 border-t px-6 py-4">
              <div className="flex items-center gap-2">
                <Button
                  className="liquid-glass-pill h-9 flex-1 rounded-full text-xs font-medium"
                  onClick={() => setMode("view")}
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  className="liquid-glass-accent h-9 flex-1 rounded-full text-xs font-medium"
                  disabled={saving || !draft.summary || !draft.dtStart}
                  onClick={handleSave}
                >
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
