"use client";

import { ModelPicker } from "@/components/shared/model-picker";
import { ThinkingSelector } from "./thinking-selector";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SlidersHorizontal } from "lucide-react";
import { TOOL_CATEGORIES, type ToolCategoryKey, type ToolConfig } from "@/lib/pi/tool-categories";

export interface ChatSettings {
  modelId: string;
  thinkingLevel: string;
  onModelChange: (value: string) => void;
  onThinkingChange: (value: string) => void;
  toolConfig: ToolConfig;
  onToggleTool: (category: ToolCategoryKey) => void;
}

/**
 * The session's settings, behind one control in the composer: the model, the
 * thinking level and the tool categories the next message runs with.
 */
export function ChatSettingsMenu({ settings }: { settings: ChatSettings }) {
  const [provider, ...modelParts] = settings.modelId.split("/");
  const modelName = modelParts.join("/");

  return (
    <DropdownMenu>
      {/* DropdownMenuTrigger renders a <button>; a styled span keeps it valid. */}
      <DropdownMenuTrigger>
        <span
          className="text-muted-foreground hover:text-foreground hover:bg-muted aria-expanded:text-foreground aria-expanded:bg-muted inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors"
          aria-label="Chat settings"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <div className="px-2 pt-1.5 pb-1">
          <ModelPicker compact value={settings.modelId} onChange={settings.onModelChange} />
        </div>
        <div className="border-border/50 border-t px-2 pt-1.5 pb-1">
          <ThinkingSelector
            value={settings.thinkingLevel}
            onChange={settings.onThinkingChange}
            modelProvider={provider || undefined}
            modelName={modelName || undefined}
          />
        </div>
        <DropdownMenuGroup className="border-border/50 mt-1 border-t pt-1">
          <DropdownMenuLabel>Tools</DropdownMenuLabel>
          {TOOL_CATEGORIES.map((category) => (
            <DropdownMenuCheckboxItem
              key={category.key}
              checked={!!settings.toolConfig[category.key]}
              onCheckedChange={() => settings.onToggleTool(category.key)}
            >
              {category.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
