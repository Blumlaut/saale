"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * One settings row: what it is on the left, its control on the right.
 *
 * The admin settings pages are a stack of these, so the row lives here once.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A settings row holding a number, clamped to its bounds when the field is left. */
export function NumberRow({
  id,
  label,
  description,
  value,
  onChange,
  min,
  max,
  unit,
}: {
  id: string;
  label: string;
  description?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  /** Suffix shown beside the field, such as "chars". */
  unit?: string;
}) {
  return (
    <SettingsRow htmlFor={id} label={label} description={description}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() =>
            onChange(String(Math.min(Math.max(Math.round(Number(value) || min), min), max)))
          }
          className="h-8 w-24 text-sm"
        />
        {unit ? <span className="text-muted-foreground text-xs">{unit}</span> : null}
      </div>
    </SettingsRow>
  );
}
