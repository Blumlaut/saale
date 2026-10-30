"use client";

import { useState, useEffect, useCallback } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { postJson } from "@/lib/http";
import type { CalendarAccountSummary } from "@/types/shared";
import {
  draftForDate,
  EMPTY_EVENT_DRAFT,
  eventDraftPayload,
  type EventDraft,
} from "@/lib/calendar/event-draft";
import { EventFormFields } from "@/components/calendar/event-form-fields";

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: CalendarAccountSummary[];
  date: Date | null;
  onSuccess?: () => void;
}

export function EventDialog({ open, onOpenChange, accounts, date, onSuccess }: EventDialogProps) {
  const [draft, setDraft] = useState<EventDraft>(EMPTY_EVENT_DRAFT);
  const [calendarId, setCalendarId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const enabledCalendars = accounts
    .flatMap((a) => a.calendars.filter((c) => c.enabled))
    .sort((a, b) => a.name.localeCompare(b.name));

  const resetForm = useCallback(() => {
    setDraft(EMPTY_EVENT_DRAFT);
    setCalendarId("");
    setError("");
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
      return;
    }

    if (date) {
      setDraft((current) => ({ ...current, ...draftForDate(date) }));
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
        ...eventDraftPayload(draft),
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
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[440px] sm:max-w-none">
        <div className="flex h-full flex-col">
          {/* Header */}
          <SheetHeader className="border-border/30 border-b px-6 pt-6 pb-4">
            <SheetTitle className="text-xl leading-tight font-semibold tracking-tight">
              New Event
            </SheetTitle>
          </SheetHeader>

          {/* Scrollable form */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <EventFormFields
              draft={draft}
              onFieldChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
              calendarField={
                <div className="space-y-2">
                  <Label className="text-xs">Calendar</Label>
                  <div className="rounded-2xl border-0 bg-transparent px-2 py-1 shadow-none">
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
              }
              error={error}
            />
          </div>

          {/* Footer */}
          <div className="border-border/30 border-t px-6 py-4">
            <Button
              className="h-9 w-full text-xs font-medium"
              disabled={saving || !draft.summary || !draft.dtStart}
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
