"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  filterOptions,
  PickerEmpty,
  PickerShell,
  type PickerOption,
} from "@/components/ui/picker-shell";

export type MultiSelectOption = PickerOption;

/** Chips the trigger shows before it counts the rest. */
const VISIBLE_CHIPS = 2;

/**
 * A dropdown that holds several values, with a search box over its options.
 *
 * The options come from whoever owns the list; the pick is the caller's state.
 * `max` caps how many the value may hold, and says so in the footer.
 */
export function MultiSelect({
  id,
  options,
  value,
  onChange,
  placeholder = "Choose values",
  searchPlaceholder = "Search",
  emptyLabel = "Nothing matches that search.",
  max,
  triggerClassName,
}: {
  id?: string;
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  max?: number;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selected = useMemo(() => new Set(value), [value]);
  const labels = useMemo(
    () => new Map(options.map((option) => [option.value, option.label])),
    [options],
  );
  const visible = useMemo(() => filterOptions(options, search), [options, search]);

  const full = max !== undefined && value.length >= max;

  const toggle = (option: string) => {
    if (selected.has(option)) {
      onChange(value.filter((entry) => entry !== option));
      return;
    }
    if (full) return;
    onChange([...value, option]);
  };

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  return (
    <PickerShell
      id={id}
      open={open}
      onOpenChange={close}
      label={placeholder}
      triggerClassName={triggerClassName}
      trigger={
        value.length === 0 ? (
          <span className="text-muted-foreground truncate">{placeholder}</span>
        ) : (
          <>
            {value.slice(0, VISIBLE_CHIPS).map((entry) => (
              <Badge key={entry} variant="secondary" className="max-w-32 truncate font-normal">
                {labels.get(entry) ?? entry}
              </Badge>
            ))}
            {value.length > VISIBLE_CHIPS ? (
              <span className="text-muted-foreground shrink-0 text-xs">
                +{value.length - VISIBLE_CHIPS}
              </span>
            ) : null}
          </>
        )
      }
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder={searchPlaceholder}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">
            {value.length === 0
              ? "Nothing picked"
              : max === undefined
                ? `${value.length} picked`
                : `${value.length} of ${max} picked`}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onChange(
                  [...new Set([...value, ...visible.map((o) => o.value)])].slice(
                    0,
                    max ?? Number.POSITIVE_INFINITY,
                  ),
                )
              }
              disabled={visible.length === 0 || full}
            >
              Add shown
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange([])}
              disabled={value.length === 0}
            >
              Clear
            </Button>
          </div>
        </div>
      }
    >
      {visible.length === 0 ? (
        <PickerEmpty>{emptyLabel}</PickerEmpty>
      ) : (
        visible.map((option) => {
          const on = selected.has(option.value);
          return (
            <label
              key={option.value}
              className={
                on || !full
                  ? "hover:bg-accent/60 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5"
                  : "flex cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 opacity-50"
              }
              role="option"
              aria-selected={on}
              aria-disabled={!on && full}
            >
              <Checkbox
                checked={on}
                disabled={!on && full}
                onCheckedChange={() => toggle(option.value)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{option.label}</span>
                {option.hint ? (
                  <span className="text-muted-foreground block truncate text-xs">
                    {option.hint}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })
      )}
    </PickerShell>
  );
}
