"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronDown, Lightbulb, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import {
  isPiThinkingLevel,
  THINKING_LEVEL_OPTIONS,
  type ThinkingLevelSetting,
} from "@/lib/pi/thinking-levels";

interface ThinkingSelectorProps {
  value: ThinkingLevelSetting | string;
  onChange: (value: string) => void;
  modelProvider?: string | undefined;
  modelName?: string | undefined;
  className?: string;
}

export function ThinkingSelector({
  value,
  onChange,
  modelProvider,
  modelName,
  className,
}: ThinkingSelectorProps) {
  // `null` means "not known yet" (still loading, or the lookup failed), which is
  // not the same as "this model supports nothing": treating the empty initial
  // list as knowledge left a thinking model with only "Default" to choose from,
  // permanently so when the request failed.
  const [availableLevels, setAvailableLevels] = useState<string[] | null>(null);

  // Fetch available thinking levels for the current model
  useEffect(() => {
    if (!modelProvider || !modelName) {
      setAvailableLevels(null);
      return;
    }

    let cancelled = false;
    setAvailableLevels(null);
    fetch(
      `/api/models/thinking-levels?provider=${encodeURIComponent(modelProvider)}&model=${encodeURIComponent(modelName)}`,
    )
      .then(async (r) => (r.ok ? ((await r.json()) as { levels?: string[] }) : null))
      .then((data) => {
        if (cancelled || !data) return;
        setAvailableLevels(data.levels ?? []);
      })
      .catch((err) => {
        // Leave the levels unknown so every option stays selectable.
        console.error("Failed to fetch thinking levels:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [modelProvider, modelName]);

  // Filter levels based on what the model supports. "default" is not a model
  // level — it always stays available, since it means "don't override Pi".
  const filteredLevels =
    modelProvider && modelName && availableLevels
      ? THINKING_LEVEL_OPTIONS.filter((l) => l.id === "default" || availableLevels.includes(l.id))
      : THINKING_LEVEL_OPTIONS;

  const selectedLevel = THINKING_LEVEL_OPTIONS.find((l) => l.id === value);

  // "default" never reaches Pi as a level, so it cannot be unsupported.
  const isLevelUnsupported =
    isPiThinkingLevel(value) &&
    Boolean(availableLevels?.length) &&
    !availableLevels!.includes(value);

  return (
    <Popover>
      {/*
        PopoverTrigger renders as <button>. Never nest a <Button> (also <button>)
        inside it — use a styled <span> instead to avoid hydration errors.
      */}
      <PopoverTrigger>
        <span
          className={cn(
            "hover:bg-accent/60 inline-flex h-7 items-center gap-1.5 px-2 text-sm font-medium transition-colors",
            className,
          )}
        >
          <Lightbulb className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          <span className="truncate text-sm">{selectedLevel?.label ?? "Default"}</span>
          <ChevronDown className="text-muted-foreground h-3 w-3 shrink-0" />
        </span>
      </PopoverTrigger>

      <PopoverContent className="w-[220px] gap-0 p-1" align="start">
        {/* Warning if current level is unsupported */}
        {isLevelUnsupported && (
          <div className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-2.5 py-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" />
            <p className="text-xs text-yellow-500/90">
              &quot;{value}&quot; is not supported by this model and will be clamped.
            </p>
          </div>
        )}

        {filteredLevels.map((level) => {
          const isSelected = level.id === value;

          return (
            <button
              key={level.id}
              className={cn(
                "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                "hover:bg-accent/60",
                isSelected && "bg-primary/10",
              )}
              onClick={() => onChange(level.id)}
            >
              {/* Check indicator */}
              <div className="flex h-4 w-4 shrink-0 items-center justify-center pt-0.5">
                {isSelected && <Check className="text-primary h-3.5 w-3.5" />}
              </div>

              {/* Level info */}
              <div className="min-w-0 flex-1">
                <div className={cn("text-sm", isSelected ? "font-medium" : "")}>{level.label}</div>
                <div className="text-muted-foreground text-xs">{level.description}</div>
              </div>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
