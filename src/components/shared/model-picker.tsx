"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Brain, Eye, Loader2, Search, Sparkles, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/http";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  reasoning: boolean | undefined;
  /** Whether this model accepts image input (images are dropped otherwise). */
  vision: boolean | undefined;
  contextWindow: number | undefined;
}

interface ModelsApiResponse {
  models: Record<
    string,
    Array<{
      id: string;
      name: string;
      reasoning?: boolean;
      vision?: boolean;
      contextWindow?: number;
    }>
  >;
  providers?: Array<{ id: string; name: string }>;
}

interface ModelPickerProps {
  /** Selected value in "provider/modelId" format */
  value: string;
  /** Callback with new value in "provider/modelId" format */
  onChange: (value: string) => void;
  /** Optional class for the trigger's inner span (the visual control) */
  className?: string;
  /** Optional class for the trigger button itself, e.g. to size it in a layout. */
  triggerClassName?: string;
  /** Placeholder when no model is selected */
  placeholder?: string;
  /**
   * Model applied while nothing is picked (the chat default), as
   * "provider/modelId". The trigger names it, so the header says what answers.
   */
  fallback?: string;
  /** Whether to show the trigger as compact (icon + name only) */
  compact?: boolean;
  /**
   * The trigger keeps its icon alone while the toolbar is narrow. Needs a
   * `@container` ancestor.
   */
  hideLabelWhenNarrow?: boolean;
  /**
   * Where the list comes from. The admin pages pick from the instance's
   * providers, which the user endpoint does not serve.
   */
  endpoint?: string;
}

/**
 * Shared model picker component.
 * - Fetches enabled models from /api/providers/models
 * - Groups by provider
 * - Built-in search
 * - Keyboard navigation
 * - Used everywhere a model needs to be selected
 */
export function ModelPicker({
  value,
  onChange,
  className,
  placeholder = "Select model",
  fallback,
  compact = false,
  hideLabelWhenNarrow = false,
  endpoint = "/api/providers/models",
  triggerClassName,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchJson<ModelsApiResponse>(endpoint)
      .then((data) => {
        const all: ModelInfo[] = [];
        if (data.models) {
          for (const [provider, modelsList] of Object.entries(data.models)) {
            const providerName =
              (data.providers ?? []).find((p) => p.id === provider)?.name ?? provider;
            for (const m of modelsList) {
              all.push({
                id: m.id,
                name: m.name,
                provider,
                providerName,
                reasoning: m.reasoning,
                vision: m.vision,
                contextWindow: m.contextWindow,
              });
            }
          }
        }
        setModels(all);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load the models for the picker:", err);
        setLoading(false);
      });
  }, [endpoint]);

  // Reset search and highlight when opening
  useEffect(() => {
    if (open) {
      setSearch("");
      setHighlightIndex(-1);
      // Focus search input after a tick for the popover to render
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [open]);

  // Group by provider
  const grouped = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const m of models) {
      if (!groups[m.provider]) groups[m.provider] = [];
      groups[m.provider]!.push(m);
    }
    return groups;
  }, [models]);

  // Filter by search
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return grouped;
    const q = search.toLowerCase();
    const result: Record<string, ModelInfo[]> = {};
    for (const [provider, providerModels] of Object.entries(grouped)) {
      const filtered = providerModels.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          provider.toLowerCase().includes(q) ||
          m.providerName.toLowerCase().includes(q),
      );
      if (filtered.length > 0) {
        result[provider] = filtered;
      }
    }
    return result;
  }, [grouped, search]);

  // Flat list for keyboard navigation
  const flatList = useMemo(() => {
    const items: Array<{ model: ModelInfo; providerKey: string }> = [];
    for (const [providerKey, providerModels] of Object.entries(filteredGroups)) {
      for (const m of providerModels) {
        items.push({ model: m, providerKey });
      }
    }
    return items;
  }, [filteredGroups]);

  const selected = models.find((m) => `${m.provider}/${m.id}` === value);
  // The fallback can be missing from the list (a disabled model, a provider the
  // user has no key for), so the reference itself stands in for its name.
  const fallbackModel = fallback
    ? models.find((m) => `${m.provider}/${m.id}` === fallback)
    : undefined;
  const fallbackLabel = fallback
    ? (fallbackModel?.name ?? fallback.slice(fallback.indexOf("/") + 1))
    : null;

  const handleSelect = (modelValue: string) => {
    onChange(modelValue);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.min(prev + 1, flatList.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && highlightIndex >= 0 && flatList[highlightIndex]) {
      e.preventDefault();
      const item = flatList[highlightIndex]!;
      handleSelect(`${item.model.provider}/${item.model.id}`);
    }
  };

  const totalFiltered = flatList.length;
  const hasResults = totalFiltered > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/*
        PopoverTrigger renders as <button>. Never nest a <Button> (also <button>)
        inside it. use a styled <span> instead to avoid hydration errors.
      */}
      <PopoverTrigger
        className={triggerClassName}
        aria-label={`Model: ${loading ? "loading" : (selected?.name ?? fallbackLabel ?? placeholder)}`}
      >
        <span
          className={cn(
            "hover:bg-accent/60 inline-flex max-w-full items-center text-sm font-medium transition-colors",
            hideLabelWhenNarrow
              ? "h-8 w-8 justify-center px-0 @[30rem]:h-7 @[30rem]:w-auto @[30rem]:justify-start @[30rem]:gap-1.5 @[30rem]:px-2"
              : "h-7 gap-1.5 px-2",
            compact ? "min-w-0" : "",
            className,
          )}
          title={selected?.name ?? (fallbackLabel ? `Default: ${fallbackLabel}` : undefined)}
        >
          {loading ? (
            <Loader2 className="text-muted-foreground animate-shrink h-3.5 w-3.5" />
          ) : (
            <Brain className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left text-sm",
              hideLabelWhenNarrow && "hidden @[30rem]:block",
            )}
          >
            {loading ? "Loading..." : (selected?.name ?? fallbackLabel ?? placeholder)}
          </span>
          <ChevronDown
            className={cn(
              "text-muted-foreground h-4 w-4 shrink-0",
              hideLabelWhenNarrow && "hidden @[30rem]:block",
            )}
          />
        </span>
      </PopoverTrigger>

      <PopoverContent className="w-[300px] gap-0 p-0 sm:w-[380px]" align="start">
        {/* Search */}
        <div className="p-2 pb-1">
          <div className="relative">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder="Search models..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setHighlightIndex(-1);
              }}
              onKeyDown={handleKeyDown}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>

        <Separator />

        {/* Model list */}
        <ScrollArea className="max-h-[340px]">
          <div className="p-1" onKeyDown={handleKeyDown}>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
              </div>
            ) : !hasResults && search ? (
              <div className="py-8 text-center">
                <p className="text-muted-foreground text-sm">No models found</p>
              </div>
            ) : !hasResults ? (
              <div className="py-8 text-center">
                <p className="text-muted-foreground text-sm">No models available</p>
                <p className="text-muted-foreground mt-1 text-xs">Add an API key in Settings</p>
              </div>
            ) : (
              Object.entries(filteredGroups).map(([providerKey, providerModels]) => (
                <div key={providerKey}>
                  {/* stays in view while the provider's own models scroll */}
                  <div className="bg-popover sticky top-0 z-10 px-2.5 py-1.5">
                    <span className="console-label">
                      {providerModels[0]?.providerName ?? providerKey}
                    </span>
                  </div>

                  {providerModels.map((model) => {
                    const modelValue = `${model.provider}/${model.id}`;
                    const isSelected = modelValue === value;
                    const isFallback = !value && modelValue === fallback;
                    const flatIndex = flatList.findIndex(
                      (item) =>
                        item.model.id === model.id && item.model.provider === model.provider,
                    );
                    const isHighlighted = flatIndex === highlightIndex;

                    return (
                      <button
                        key={model.id}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                          isHighlighted ? "bg-accent" : "hover:bg-accent/60",
                          isSelected && "bg-primary/10",
                        )}
                        onClick={() => handleSelect(modelValue)}
                        onMouseEnter={() => setHighlightIndex(flatIndex)}
                      >
                        {/* Check indicator */}
                        <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                          {isSelected && <Check className="text-primary h-3.5 w-3.5" />}
                        </div>

                        {/* the group label already names the provider */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "line-clamp-2 min-w-0 flex-1 text-sm break-words",
                                isSelected && "font-medium",
                              )}
                              title={model.name}
                            >
                              {model.name}
                            </span>
                            {model.reasoning && (
                              <Sparkles className="text-muted-foreground h-3 w-3 shrink-0" />
                            )}
                            {model.vision && (
                              <span title="Accepts image input">
                                <Eye className="text-muted-foreground h-3 w-3 shrink-0" />
                              </span>
                            )}
                            {isFallback && (
                              <span className="text-muted-foreground shrink-0 text-xs">
                                default
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}

                  {/* Separator between providers */}
                  {Object.keys(filteredGroups).indexOf(providerKey) <
                    Object.keys(filteredGroups).length - 1 && <Separator className="mx-1 my-1" />}
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        {hasResults && (
          <>
            <Separator />
            <div className="px-3 py-1.5">
              <span className="text-muted-foreground text-[11px]">
                {totalFiltered} model{totalFiltered !== 1 ? "s" : ""} available
              </span>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
