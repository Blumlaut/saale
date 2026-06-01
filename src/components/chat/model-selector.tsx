"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Brain, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

const models = [
  { id: "claude-sonnet-4-5-20250514", label: "Claude Sonnet 4.5", provider: "Anthropic" },
  { id: "claude-opus-4-1-20250514", label: "Claude Opus 4", provider: "Anthropic" },
  { id: "claude-haiku-3-5-20241022", label: "Claude Haiku 3.5", provider: "Anthropic" },
  { id: "gpt-4o", label: "GPT-4o", provider: "OpenAI" },
  { id: "gpt-4o-mini", label: "GPT-4o Mini", provider: "OpenAI" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Google" },
];

export function ModelSelector({ value, onChange, className }: ModelSelectorProps) {
  const selected = models.find((m) => m.id === value) ?? models[0];

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent p-1.5 shadow-none hover:bg-white/10 dark:hover:bg-white/5">
          <Brain className="h-3.5 w-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              <div className="flex items-center gap-2">
                <span>{model.label}</span>
                <span className="text-muted-foreground text-xs">{model.provider}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
