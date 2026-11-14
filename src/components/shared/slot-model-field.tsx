"use client";

import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/shared/model-picker";
import { toPickerModelId, toStoredModelId } from "@/lib/pi/model-ref";
import { cn } from "@/lib/utils";
import { RotateCcw, type LucideIcon } from "lucide-react";

/** The look the settings pages give a picker's trigger. */
const CONTROL_TRIGGER =
  "h-8 w-full justify-between rounded-lg border pr-2 pl-2.5 text-sm font-normal dark:bg-input/30";

export interface SlotModelFieldProps {
  /** Which of Pi's model lists to offer. */
  type: "classifier" | "image";
  /** The picked model as `provider:model`, or null while the fallback applies. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** The model that applies while nothing is picked, as `provider:model`. */
  fallback: string | null;
  /** Where the model list comes from: the account's providers or the instance's. */
  endpoint: string;
  /** Shown in the trigger while nothing is picked. */
  placeholder?: string;
  /** The clear button's accessible name. */
  clearLabel?: string;
  label?: string;
  /** The line under the label. null leaves it out, for a row in a list of them. */
  description?: string | null;
  /** Shown before the label, as the rows of a list carry one. */
  icon?: LucideIcon;
}

/**
 * A model that does something other than chat, on the page that owns its
 * setting: the account's own choice on Settings → Models, the instance default
 * on the admin model page.
 */
export function SlotModelField({
  type,
  value,
  onChange,
  fallback,
  endpoint,
  placeholder = "Instance default",
  clearLabel = "Clear the model",
  label,
  description = null,
  icon: Icon,
}: SlotModelFieldProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-2.5">
        {Icon ? <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" /> : null}
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
        <ModelPicker
          type={type}
          value={value ? toPickerModelId(value) : ""}
          onChange={(next) => onChange(next ? toStoredModelId(next) : null)}
          placeholder={placeholder}
          fallback={fallback ? toPickerModelId(fallback) : ""}
          endpoint={endpoint}
          className={cn(CONTROL_TRIGGER, "sm:w-56")}
        />
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8 shrink-0", !value && "invisible")}
          aria-label={clearLabel}
          tabIndex={value ? 0 : -1}
          onClick={() => onChange(null)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
