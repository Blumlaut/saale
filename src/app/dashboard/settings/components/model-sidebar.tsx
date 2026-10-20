"use client";

import { CheckCircle, Globe, RotateCcw, Brain, Zap, AlertCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getAllPurposes } from "@/lib/pi/purposes";
import { DEFAULT_THINKING_LEVEL_SETTING, thinkingLevelOptionsFor } from "@/lib/pi/thinking-levels";
import { useModelThinkingLevels } from "@/hooks/use-thinking-levels";
import type { UserSettings } from "../types";

/** Icons are presentation-only — the level list itself lives in one place. */
const THINKING_LEVEL_ICONS: Record<string, typeof Zap> = {
  default: Sparkles,
  off: Zap,
};

interface ModelSidebarProps {
  settings: UserSettings | null;
  activePurpose: string;
  onPurposeChange: (purpose: string) => void;
  effectiveModel: { provider: string; model: string } | null;
  selectedProvider: { id: string; name: string } | undefined;
  isPurposeOverride: boolean;
  onResetPurpose: () => void;
  onSettingsChange: (settings: UserSettings) => void;
}

export function ModelSidebar({
  settings,
  activePurpose,
  onPurposeChange,
  effectiveModel,
  selectedProvider,
  isPurposeOverride,
  onResetPurpose,
  onSettingsChange,
}: ModelSidebarProps) {
  const purposes = getAllPurposes();

  // Thinking levels are only asked for while the default model is in play.
  const currentLevel = settings?.defaultThinkingLevel || DEFAULT_THINKING_LEVEL_SETTING;
  const thinkingLevels = useModelThinkingLevels(
    activePurpose === "__default__" ? effectiveModel?.provider : null,
    activePurpose === "__default__" ? effectiveModel?.model : null,
    currentLevel,
  );

  const filteredLevels = thinkingLevelOptionsFor(thinkingLevels.levels).map((level) => ({
    ...level,
    icon: THINKING_LEVEL_ICONS[level.id] ?? Brain,
  }));

  return (
    <div className="w-full lg:w-[260px]">
      <div className="sticky top-6 space-y-5">
        {/* Purpose selector */}
        <div className="space-y-2 pt-3">
          <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Purpose
          </Label>

          <div className="liquid-glass-inner space-y-0.5 rounded-2xl border-0 p-1">
            <Button
              variant="ghost"
              className={cn(
                "w-full justify-start gap-2.5 rounded-xl px-3 py-2 text-sm",
                activePurpose === "__default__"
                  ? "bg-primary/10 text-foreground"
                  : "hover:bg-accent/60",
              )}
              onClick={() => onPurposeChange("__default__")}
            >
              <div
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                  activePurpose === "__default__"
                    ? "bg-primary/15 text-primary"
                    : "bg-muted/50 text-muted-foreground",
                )}
              >
                <Globe className="h-3 w-3" />
              </div>
              <div className="flex-1 text-left">
                <p
                  className={cn(
                    "text-sm leading-none",
                    activePurpose === "__default__" && "font-medium",
                  )}
                >
                  Default
                </p>
              </div>
              {activePurpose === "__default__" && (
                <CheckCircle className="text-primary h-3.5 w-3.5" />
              )}
            </Button>

            {purposes.map((purpose) => {
              const isActive = activePurpose === purpose.id;
              const PurposeIcon = purpose.icon;
              const hasOverride = !!(settings?.purposeModelOverrides ?? {})[purpose.id]?.provider;

              return (
                <div key={purpose.id}>
                  <Separator className="mx-2" />
                  <Button
                    variant="ghost"
                    className={cn(
                      "w-full justify-start gap-2.5 rounded-xl px-3 py-2 text-sm",
                      isActive ? "bg-primary/10 text-foreground" : "hover:bg-accent/60",
                    )}
                    onClick={() => onPurposeChange(purpose.id)}
                  >
                    <div
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                        isActive
                          ? "bg-primary/15 text-primary"
                          : "bg-muted/50 text-muted-foreground",
                      )}
                    >
                      <PurposeIcon className="h-3 w-3" />
                    </div>
                    <div className="flex-1 text-left">
                      <p className={cn("text-sm leading-none", isActive && "font-medium")}>
                        {purpose.label}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-[11px]">
                        {hasOverride ? "Custom" : "Using default"}
                      </p>
                    </div>
                    {isActive && <CheckCircle className="text-primary h-3.5 w-3.5" />}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected model */}
        {effectiveModel && selectedProvider && (
          <div className="liquid-glass-inner rounded-2xl border-0 p-3">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground text-[11px]">
                {activePurpose === "__default__"
                  ? "Default model"
                  : (() => {
                      const p = purposes.find((pr) => pr.id === activePurpose);
                      return p ? `${p.label} model` : "Model";
                    })()}
              </p>
              {isPurposeOverride && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-5 gap-1 px-1.5 text-[10px]"
                  onClick={onResetPurpose}
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </Button>
              )}
            </div>
            <p className="mt-0.5 text-sm font-medium">{effectiveModel.model}</p>
            <p className="text-muted-foreground text-xs">{selectedProvider.name}</p>
          </div>
        )}

        {/* Thinking level */}
        {activePurpose === "__default__" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Thinking
              </Label>
              {thinkingLevels.reasoning === false && (
                <span className="text-muted-foreground text-[10px]">Not supported</span>
              )}
            </div>

            {/* Warning if current level is unsupported */}
            {thinkingLevels.unsupported && (
              <div className="flex items-start gap-2 rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-3 py-2">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" />
                <p className="text-xs text-yellow-500/90">
                  {thinkingLevels.clampedLevel
                    ? `"${currentLevel}" is not supported by this model and will be clamped to "${thinkingLevels.clampedLevel}".`
                    : `"${currentLevel}" is not supported by this model and will be clamped.`}
                </p>
              </div>
            )}

            <div className="liquid-glass-inner space-y-0.5 rounded-2xl border-0 p-1">
              {filteredLevels.map((level, index) => {
                const isActive = settings?.defaultThinkingLevel === level.id;
                const Icon = level.icon;

                return (
                  <div key={level.id}>
                    {index > 0 && <Separator className="mx-2" />}
                    <Button
                      variant="ghost"
                      className={cn(
                        "w-full justify-start gap-2.5 rounded-xl px-3 py-2 text-sm",
                        isActive ? "bg-primary/10 text-foreground" : "hover:bg-accent/60",
                      )}
                      onClick={() => {
                        if (settings) {
                          onSettingsChange({
                            ...settings,
                            defaultThinkingLevel: level.id,
                          });
                        }
                      }}
                    >
                      <div
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                          isActive
                            ? "bg-primary/15 text-primary"
                            : "bg-muted/50 text-muted-foreground",
                        )}
                      >
                        <Icon className="h-3 w-3" />
                      </div>
                      <div className="flex-1 text-left">
                        <p className={cn("text-sm leading-none", isActive && "font-medium")}>
                          {level.label}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-[11px]">
                          {level.description}
                        </p>
                      </div>
                      {isActive && <CheckCircle className="text-primary h-3.5 w-3.5" />}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
