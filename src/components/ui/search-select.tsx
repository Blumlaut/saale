"use client";

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import {
  filterOptions,
  PickerEmpty,
  PickerShell,
  type PickerOption,
} from "@/components/ui/picker-shell";

/**
 * A dropdown that holds one value, with a search box over its options.
 *
 * Every value is an option, so a "nothing" choice is one too, named by the
 * caller.
 */
export function SearchSelect({
  id,
  options,
  value,
  onChange,
  placeholder = "Choose a value",
  searchPlaceholder = "Search",
  emptyLabel = "Nothing matches that search.",
  triggerClassName,
}: {
  id?: string;
  options: readonly PickerOption[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const visible = useMemo(() => filterOptions(options, search), [options, search]);
  const current = options.find((option) => option.value === value);

  const close = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  const pick = (next: string) => {
    onChange(next);
    close(false);
  };

  return (
    <PickerShell
      id={id}
      open={open}
      onOpenChange={close}
      label={placeholder}
      triggerClassName={triggerClassName}
      trigger={
        current ? (
          <span className="truncate">{current.label}</span>
        ) : (
          <span className="text-muted-foreground truncate">{placeholder}</span>
        )
      }
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder={searchPlaceholder}
    >
      {visible.length === 0 ? (
        <PickerEmpty>{emptyLabel}</PickerEmpty>
      ) : (
        visible.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            onClick={() => pick(option.value)}
            className="hover:bg-accent/60 flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{option.label}</span>
              {option.hint ? (
                <span className="text-muted-foreground block truncate text-xs">{option.hint}</span>
              ) : null}
            </span>
            {option.value === value ? <Check className="text-primary h-4 w-4 shrink-0" /> : null}
          </button>
        ))
      )}
    </PickerShell>
  );
}
