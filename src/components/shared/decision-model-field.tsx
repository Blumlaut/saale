"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ModelPicker } from "@/components/shared/model-picker";
import { toPickerModelId, toStoredModelId } from "@/lib/pi/model-ref";
import { cn } from "@/lib/utils";
import { RotateCcw } from "lucide-react";

/** The look the settings pages give a picker's trigger. */
const CONTROL_TRIGGER =
  "h-8 w-full justify-between rounded-lg border pr-2 pl-2.5 text-sm font-normal dark:bg-input/30";

export interface DecisionModelFieldProps {
  /** The picked model as `provider:model`, or null while the fallback applies. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** What applies while nothing is picked, named in the hint line. */
  fallback: string | null;
  /** What the fallback is, for the hint line's start: "the instance default", … */
  fallbackLabel?: string;
  /** Where the model list comes from: the account's providers or the instance's. */
  endpoint: string;
  label?: string;
  description?: string;
}

/**
 * The decision model that judges what Auto would run, on the page that owns the
 * setting: the account's own on Settings → Tools, the instance default on the
 * admin model page.
 */
export function DecisionModelField({
  value,
  onChange,
  fallback,
  fallbackLabel = "the instance default",
  endpoint,
  label = "Decision model",
  description = "Judges the tool calls Auto would run on its own. It reads the tool name and its arguments, and a call it cannot judge goes to you.",
}: DecisionModelFieldProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
        {!value && (
          <p className="text-muted-foreground mt-0.5 text-xs">
            {fallback
              ? `Follows ${fallbackLabel}: ${fallback}`
              : "Not set. The built-in command checks decide."}
          </p>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
        <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
          <ModelPicker
            type="classifier"
            value={value ? toPickerModelId(value) : ""}
            onChange={(next) => onChange(next ? toStoredModelId(next) : null)}
            placeholder="Built-in checks"
            endpoint={endpoint}
            triggerClassName="w-full"
            className={CONTROL_TRIGGER}
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8 shrink-0", !value && "invisible")}
          aria-label="Clear the decision model"
          tabIndex={value ? 0 : -1}
          onClick={() => onChange(null)}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
