"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

  // Stable across renders: the sheet's effect seeds the form from these, and a
  // fresh array each render would re-run it forever.
  const enabledCalendars = useMemo(
    () =>
      accounts
        .flatMap((a) => a.calendars.filter((c) => c.enabled))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );
  const calendarItems = useMemo(
    () => enabledCalendars.map((cal) => ({ value: cal.id, label: cal.name })),
    [enabledCalendars],
  );

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
    }

    const firstCalendar = enabledCalendars[0];
    if (firstCalendar) {
      setCalendarId(firstCalendar.id);
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
                  <Select
                    items={calendarItems}
                    value={calendarId}
                    onValueChange={(value) => setCalendarId(value ?? "")}
                  >
                    <SelectTrigger aria-label="Calendar to write to" className="w-full">
                      <SelectValue placeholder="No calendar connected" />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledCalendars.map((cal) => (
                        <SelectItem key={cal.id} value={cal.id}>
                          {cal.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
