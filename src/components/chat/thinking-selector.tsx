"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Check, ChevronDown, Lightbulb, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModelThinkingLevels } from "@/hooks/use-thinking-levels";
import {
  THINKING_LEVEL_OPTIONS,
  thinkingLevelOptionsFor,
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
  const { levels, clampedLevel, unsupported } = useModelThinkingLevels(
    modelProvider,
    modelName,
    value,
  );

  const filteredLevels = thinkingLevelOptionsFor(levels);

  const selectedLevel = THINKING_LEVEL_OPTIONS.find((l) => l.id === value);

  return (
    <Popover>
      {/*
        PopoverTrigger renders as <button>. Never nest a <Button> (also <button>)
        inside it. use a styled <span> instead to avoid hydration errors.
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
        {unsupported && (
          <div className="flex items-start gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-2.5 py-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" />
            <p className="text-xs text-yellow-500/90">
              {clampedLevel
                ? `"${value}" is not supported by this model and will be clamped to "${clampedLevel}".`
                : `"${value}" is not supported by this model and will be clamped.`}
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
