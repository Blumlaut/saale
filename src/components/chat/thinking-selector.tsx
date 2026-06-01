"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

interface ThinkingSelectorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

const thinkingLevels = [
  { id: "off", label: "Off", description: "Faster responses" },
  { id: "minimal", label: "Minimal", description: "Light reasoning" },
  { id: "low", label: "Low", description: "Basic reasoning" },
  { id: "medium", label: "Medium", description: "Balanced" },
  { id: "high", label: "High", description: "Deep reasoning" },
];

export function ThinkingSelector({ value, onChange, className }: ThinkingSelectorProps) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent p-1.5 shadow-none hover:bg-white/10 dark:hover:bg-white/5">
          <Lightbulb className="h-3.5 w-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {thinkingLevels.map((level) => (
            <SelectItem key={level.id} value={level.id}>
              <div className="flex flex-col">
                <span>{level.label}</span>
                <span className="text-muted-foreground text-xs">{level.description}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
