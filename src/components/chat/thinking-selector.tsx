"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronDown, Lightbulb, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

interface ThinkingSelectorProps {
  value: string;
  onChange: (value: string) => void;
  modelProvider?: string | undefined;
  modelName?: string | undefined;
  className?: string;
}

const ALL_THINKING_LEVELS = [
  { id: "off", label: "Off", description: "Faster responses" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Basic reasoning" },
  { id: "medium", label: "Medium", description: "Balanced" },
  { id: "high", label: "High", description: "Deep reasoning" },
  { id: "xhigh", label: "X-High", description: "Maximum depth" },
  { id: "max", label: "Max", description: "Deepest reasoning" },
];

export function ThinkingSelector({
  value,
  onChange,
  modelProvider,
  modelName,
  className,
}: ThinkingSelectorProps) {
  const [availableLevels, setAvailableLevels] = useState<string[]>([]);

  // Fetch available thinking levels for the current model
  useEffect(() => {
    if (!modelProvider || !modelName) {
      setAvailableLevels([]);
      return;
    }

    let cancelled = false;
    fetch(
      `/api/models/thinking-levels?provider=${encodeURIComponent(modelProvider)}&model=${encodeURIComponent(modelName)}`,
    )
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setAvailableLevels(data.levels ?? []);
      })
      .catch((err) => {
        console.error("Failed to fetch thinking levels:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [modelProvider, modelName]);

  // Filter levels based on what the model supports
  const filteredLevels =
    modelProvider && modelName
      ? ALL_THINKING_LEVELS.filter((l) => availableLevels.includes(l.id))
      : ALL_THINKING_LEVELS;

  const selectedLevel = ALL_THINKING_LEVELS.find((l) => l.id === value);

  // Check if current level is unsupported
  const isLevelUnsupported =
    modelProvider && modelName && availableLevels.length > 0 && !availableLevels.includes(value);

  return (
    <Popover>
      {/*
        PopoverTrigger renders as <button>. Never nest a <Button> (also <button>)
        inside it — use a styled <span> instead to avoid hydration errors.
      */}
      <PopoverTrigger>
        <span
          className={cn(
            "inline-flex h-7 items-center gap-1.5 px-2 text-sm font-medium transition-colors hover:bg-white/10 dark:hover:bg-white/5",
            className,
          )}
        >
          <Lightbulb className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          <span className="truncate text-sm">{selectedLevel?.label ?? "Off"}</span>
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
                "hover:bg-white/10 dark:hover:bg-white/5",
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
