"use client";

import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Brain, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

interface ModelSelectorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function ModelSelector({ value, onChange, className }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/providers/models")
      .then((r) => r.json())
      .then((data) => {
        const all: ModelInfo[] = [];
        if (data.models) {
          for (const [provider, modelsList] of Object.entries(data.models)) {
            for (const m of modelsList as { id: string; name: string; reasoning: boolean }[]) {
              all.push({
                id: m.id,
                name: m.name,
                provider,
                reasoning: m.reasoning,
              });
            }
          }
        }
        // Sort: reasoning models first, then alphabetical
        all.sort((a, b) => {
          if (a.reasoning !== b.reasoning) return b.reasoning ? 1 : -1;
          return a.name.localeCompare(b.name);
        });
        setModels(all);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Group by provider for display
  const byProvider: Record<string, ModelInfo[]> = {};
  for (const m of models) {
    const provider = m.provider;
    if (!byProvider[provider]) byProvider[provider] = [];
    byProvider[provider]!.push(m);
  }

  // value is in "provider/modelId" format
  const selected = models.find((m) => `${m.provider}/${m.id}` === value);

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Select value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent p-1.5 shadow-none hover:bg-white/10 dark:hover:bg-white/5">
          {loading ? (
            <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
          ) : (
            <Brain className="text-muted-foreground h-3.5 w-3.5" />
          )}
          <SelectValue placeholder={loading ? "Loading..." : selected?.name || "Select model"} />
        </SelectTrigger>
        <SelectContent>
          {models.length === 0 ? (
            <SelectItem value="none" disabled>
              Add an API key in Settings
            </SelectItem>
          ) : (
            Object.entries(byProvider).map(([provider, providerModels]) => (
              <div key={provider}>
                <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                  {provider}
                </div>
                {providerModels.map((model) => (
                  <SelectItem key={model.id} value={`${provider}/${model.id}`}>
                    <div className="flex items-center gap-2">
                      <span>{model.name}</span>
                      {model.reasoning && <span className="text-muted-foreground text-xs">✦</span>}
                    </div>
                  </SelectItem>
                ))}
              </div>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
