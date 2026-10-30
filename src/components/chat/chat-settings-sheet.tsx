"use client";

import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ToolCategoryRow } from "@/components/shared/tool-category-row";
import { useModelThinkingLevels } from "@/hooks/use-thinking-levels";
import { thinkingLevelOptionsFor } from "@/lib/pi/thinking-levels";
import { isCategoryEnabled, TOOL_CATEGORIES, type ToolCategoryKey } from "@/lib/pi/tool-categories";
import type { ToolConfig } from "@/lib/pi/tool-categories";
import { SlidersHorizontal } from "lucide-react";

/** The session's own settings, apart from the model the header shows. */
export interface ChatSettings {
  /** Only read, to know which levels the model offers. */
  modelId: string;
  thinkingLevel: string;
  onThinkingChange: (value: string) => void;
  toolConfig: ToolConfig;
  onToggleTool: (category: ToolCategoryKey) => void;
}

/**
 * How the next message runs: the thinking level and the tools. A sheet rather
 * than a menu, because the tool list alone is a dozen rows.
 */
export function ChatSettingsSheet({ settings }: { settings: ChatSettings }) {
  const [open, setOpen] = useState(false);
  const [provider, ...modelParts] = settings.modelId.split("/");
  const thinking = useModelThinkingLevels(provider, modelParts.join("/"), settings.thinkingLevel);
  const levels = thinkingLevelOptionsFor(thinking.levels);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* SheetTrigger renders a <button>; the span keeps the console styling. */}
      <SheetTrigger>
        <span
          className="text-muted-foreground hover:text-foreground hover:bg-muted aria-expanded:text-foreground inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors"
          aria-label="Chat settings"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </span>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[400px] sm:max-w-none">
        <SheetHeader className="border-border/30 border-b px-4 pt-4 pb-3">
          <SheetTitle>Chat settings</SheetTitle>
          <SheetDescription>Thinking level and the tools this chat can use.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-2">
            <Label>Thinking</Label>
            {/* Every level on the surface: picking one costs a single click. */}
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Thinking level">
              {levels.map((level) => (
                <Button
                  key={level.id}
                  type="button"
                  size="xs"
                  variant={level.id === settings.thinkingLevel ? "default" : "secondary"}
                  aria-pressed={level.id === settings.thinkingLevel}
                  title={level.description}
                  onClick={() => settings.onThinkingChange(level.id)}
                >
                  {level.label}
                </Button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              {thinking.reasoning === false
                ? "This model answers straight away."
                : thinking.unsupported
                  ? "This model does not offer that level. it falls back to its own default."
                  : "How long the model may think before answering."}
            </p>
          </div>

          <Separator className="my-5" />

          <div>
            <p className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
              Tools
            </p>
            <div className="mt-1">
              {TOOL_CATEGORIES.map((category, index) => (
                <div key={category.key}>
                  {index > 0 && <Separator />}
                  <ToolCategoryRow
                    category={category}
                    checked={isCategoryEnabled(settings.toolConfig, category.key)}
                    onCheckedChange={() => settings.onToggleTool(category.key)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
