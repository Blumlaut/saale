"use client";

import { useId } from "react";

import { AlertCircle, MapPin } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { EventDraft } from "@/lib/calendar/event-draft";

interface EventFormFieldsProps {
  draft: EventDraft;
  onFieldChange: <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => void;
  /** Where to put a create-only field, such as which calendar to write to. */
  calendarField?: React.ReactNode;
  error?: string;
}

/** The fields of an event, in the order both event sheets show them. */
export function EventFormFields({
  draft,
  onFieldChange,
  calendarField,
  error,
}: EventFormFieldsProps) {
  const allDayId = useId();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs">Title</Label>
        <Input
          className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
          placeholder="Meeting title"
          value={draft.summary}
          onChange={(e) => onFieldChange("summary", e.target.value)}
        />
      </div>

      {calendarField}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label className="text-xs">Start</Label>
          <Input
            className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
            type={draft.allDay ? "date" : "datetime-local"}
            value={draft.dtStart}
            onChange={(e) => onFieldChange("dtStart", e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">End</Label>
          <Input
            className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
            type={draft.allDay ? "date" : "datetime-local"}
            value={draft.dtEnd}
            onChange={(e) => onFieldChange("dtEnd", e.target.value)}
          />
        </div>
      </div>

      <div className="liquid-glass-inner flex items-center justify-between rounded-2xl px-4 py-3">
        <Label htmlFor={allDayId} className="text-sm">
          All day
        </Label>
        <Switch
          checked={draft.allDay}
          id={allDayId}
          onCheckedChange={(checked) => onFieldChange("allDay", checked)}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">
          <MapPin className="mr-1 inline h-3 w-3" />
          Location
        </Label>
        <Input
          className="liquid-glass-inner h-10 rounded-full border-0 bg-transparent px-4 shadow-none"
          placeholder="Room, address, or video link"
          value={draft.location}
          onChange={(e) => onFieldChange("location", e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Description</Label>
        <Textarea
          className="liquid-glass-inner min-h-[80px] rounded-2xl border-0 bg-transparent px-4 pt-3 shadow-none"
          placeholder="Notes, agenda, etc."
          rows={3}
          value={draft.description}
          onChange={(e) => onFieldChange("description", e.target.value)}
        />
      </div>

      {error && (
        <div className="liquid-glass-destructive flex items-center gap-2 rounded-2xl px-4 py-3">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="text-xs">{error}</span>
        </div>
      )}
    </div>
  );
}
