"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { cn } from "@/lib/utils";
import { SearchSelect } from "@/components/ui/search-select";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageSection } from "@/components/layout/page";
import { fetchJson } from "@/lib/http";
import type { SearchInstance } from "@/lib/web/instance";
import {
  clampSetting,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_RESULTS_PER_CALL,
  DEFAULT_SEARCH_CATEGORIES,
  MAX_FETCH_TIMEOUT_MS,
  MAX_MAX_CHARS,
  MAX_MAX_REDIRECTS,
  MAX_RESULTS_PER_CALL,
  MIN_FETCH_TIMEOUT_MS,
  MIN_MAX_CHARS,
} from "@/lib/web/tools-config";
import { SettingsRow, NumberRow } from "./settings-rows";
import { AdminSettingsFrame } from "./settings-frame";
import { useAdminSettings } from "./use-admin-settings";

/** The category pick that filters nothing. */
const ALL_CATEGORIES = "*";

const SAFE_SEARCH_LABELS: Record<string, string> = {
  "0": "Off",
  "1": "Moderate",
  "2": "Strict",
};

type EngineState =
  | { status: "loading" }
  | { status: "ready"; instance: SearchInstance }
  | { status: "error"; message: string };

/** The engines a search may use, and the budget a page fetch runs with. */
export function SearchSection() {
  const { settings, loading, saving, saveStatus, save } = useAdminSettings();

  const [engines, setEngines] = useState<string[] | null>(null);
  const [categories, setCategories] = useState<string[] | null>(null);
  const [safeSearch, setSafeSearch] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [resultsPerCall, setResultsPerCall] = useState<string | null>(null);
  const [maxChars, setMaxChars] = useState<string | null>(null);
  const [timeoutMs, setTimeoutMs] = useState<string | null>(null);
  const [maxRedirects, setMaxRedirects] = useState<string | null>(null);

  const [instance, setInstance] = useState<EngineState>({ status: "loading" });
  const [filter, setFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES);
  const [showDisabled, setShowDisabled] = useState(false);

  const loadInstance = useCallback(() => {
    setInstance({ status: "loading" });
    fetchJson<{ instance: SearchInstance }>("/api/admin/search/engines")
      .then((data) => setInstance({ status: "ready", instance: data.instance }))
      .catch((err: unknown) => {
        console.error("Failed to read the search instance's engines:", err);
        setInstance({
          status: "error",
          message: err instanceof Error ? err.message : "The search instance did not answer.",
        });
      });
  }, []);

  useEffect(loadInstance, [loadInstance]);

  const selected = useMemo(
    () => engines ?? settings?.webSearchEngines ?? [],
    [engines, settings?.webSearchEngines],
  );
  const chosen = useMemo(() => new Set(selected), [selected]);

  const toggleEngine = (name: string) => {
    setEngines((current) => {
      const now = current ?? settings?.webSearchEngines ?? [];
      // The switch is the way back to every engine, so the pick keeps one.
      if (now.length === 1 && now[0] === name) return now;
      const next = new Set(now);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return [...next];
    });
  };

  const visibleEngines = useMemo(() => {
    if (instance.status !== "ready") return [];
    const needle = filter.trim().toLowerCase();
    return instance.instance.engines.filter(
      (engine) =>
        (showDisabled || engine.enabled) &&
        (categoryFilter === ALL_CATEGORIES || engine.categories.includes(categoryFilter)) &&
        (needle === "" ||
          engine.name.toLowerCase().includes(needle) ||
          engine.categories.some((category) => category.toLowerCase().includes(needle))),
    );
  }, [instance, filter, categoryFilter, showDisabled]);

  /** Nothing picked means every engine the instance runs, which is the switch on. */
  const usesEveryEngine = selected.length === 0;

  const enabledEngines = useMemo(
    () =>
      instance.status === "ready"
        ? instance.instance.engines.filter((engine) => engine.enabled)
        : [],
    [instance],
  );
  const enabledCount = enabledEngines.length;

  /**
   * The switch hands over the engines in use either way: every engine the
   * instance runs, or a list that starts as that whole set.
   */
  const toggleEveryEngine = (everyEngine: boolean) => {
    if (everyEngine) {
      setEngines([]);
      return;
    }
    if (enabledEngines.length > 0) setEngines(enabledEngines.map((engine) => engine.name));
  };

  /** Adds the listed engines to the pick, for a whole visible list at a time. */
  const addEngines = (names: readonly string[]) => {
    setEngines((current) => [
      ...new Set([...(current ?? settings?.webSearchEngines ?? []), ...names]),
    ]);
  };

  const categoryFilterOptions = useMemo(() => {
    const known = instance.status === "ready" ? instance.instance.categories : [];
    return [
      { value: ALL_CATEGORIES, label: "All categories" },
      ...known.map((name) => ({ value: name, label: name })),
    ];
  }, [instance]);

  const selectedCategories = useMemo(
    () => categories ?? settings?.webSearchCategories ?? [...DEFAULT_SEARCH_CATEGORIES],
    [categories, settings?.webSearchCategories],
  );

  // The instance's own list, plus anything already stored that it no longer has.
  const categoryOptions = useMemo(() => {
    const known = instance.status === "ready" ? instance.instance.categories : [];
    const names = [...new Set([...known, ...selectedCategories])];
    return names.map((name) => ({ value: name, label: name }));
  }, [instance, selectedCategories]);

  const saveAll = () =>
    void save({
      webSearchEngines: selected,
      webSearchCategories: cleanCategories(selectedCategories),
      webSearchSafeSearch: Number(safeSearch ?? settings?.webSearchSafeSearch ?? 0),
      webSearchLanguage: (language ?? settings?.webSearchLanguage ?? "all").trim() || "all",
      webSearchResultsPerCall: clampSetting(
        Number(resultsPerCall ?? settings?.webSearchResultsPerCall ?? DEFAULT_RESULTS_PER_CALL),
        1,
        MAX_RESULTS_PER_CALL,
        DEFAULT_RESULTS_PER_CALL,
      ),
      webFetchMaxChars: clampSetting(
        Number(maxChars ?? settings?.webFetchMaxChars ?? DEFAULT_MAX_CHARS),
        MIN_MAX_CHARS,
        MAX_MAX_CHARS,
        DEFAULT_MAX_CHARS,
      ),
      webFetchTimeoutMs: clampSetting(
        Number(timeoutMs ?? settings?.webFetchTimeoutMs ?? 15_000),
        MIN_FETCH_TIMEOUT_MS,
        MAX_FETCH_TIMEOUT_MS,
        15_000,
      ),
      webFetchMaxRedirects: clampSetting(
        Number(maxRedirects ?? settings?.webFetchMaxRedirects ?? DEFAULT_MAX_REDIRECTS),
        0,
        MAX_MAX_REDIRECTS,
        DEFAULT_MAX_REDIRECTS,
      ),
    });

  return (
    <AdminSettingsFrame loading={loading} saving={saving} status={saveStatus} onSave={saveAll}>
      <PageSection title="Sources">
        <SettingsRow
          htmlFor="use-every-engine"
          label="Use every engine"
          description={
            usesEveryEngine
              ? `All ${enabledCount} engines the instance runs are in use.`
              : "A search uses the engines ticked below."
          }
        >
          <Switch
            id="use-every-engine"
            checked={usesEveryEngine}
            disabled={instance.status !== "ready"}
            onCheckedChange={toggleEveryEngine}
          />
        </SettingsRow>

        <div className="space-y-3 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by name or category"
              aria-label="Filter engines"
              className="h-8 w-full max-w-64 text-sm"
            />
            {instance.status === "ready" ? (
              <SearchSelect
                id="engine-category"
                placeholder="Filter by category"
                searchPlaceholder="Search categories"
                options={categoryFilterOptions}
                value={categoryFilter}
                onChange={setCategoryFilter}
                triggerClassName="w-40 sm:w-44"
              />
            ) : null}
            <Button variant="ghost" size="sm" onClick={loadInstance}>
              <RotateCw className="h-3.5 w-3.5" />
              Reload
            </Button>
            <span className="text-muted-foreground ml-auto text-xs">
              {instance.status === "ready"
                ? `Read from ${instance.instance.name || "the search instance"}.`
                : "The engines come from the search instance itself."}
            </span>
          </div>

          {instance.status === "loading" ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : instance.status === "error" ? (
            <p className="text-destructive text-xs">{instance.message}</p>
          ) : (
            <>
              <div
                className="border-border grid max-h-[26rem] gap-x-4 overflow-y-auto rounded-xl border px-3 py-1 md:grid-cols-2 lg:grid-cols-3"
                aria-label="Search engines"
              >
                {visibleEngines.length === 0 ? (
                  <p className="text-muted-foreground col-span-full px-1 py-6 text-center text-xs">
                    No engine matches that filter.
                  </p>
                ) : (
                  visibleEngines.map((engine) => (
                    <label
                      key={engine.name}
                      className={cn(
                        "flex items-center gap-2 rounded-md py-1.5",
                        usesEveryEngine ? "cursor-default" : "hover:bg-accent/40 cursor-pointer",
                      )}
                    >
                      <Checkbox
                        checked={usesEveryEngine ? engine.enabled : chosen.has(engine.name)}
                        disabled={
                          usesEveryEngine || (selected.length === 1 && chosen.has(engine.name))
                        }
                        onCheckedChange={() => toggleEngine(engine.name)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-sm">{engine.name}</span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {engine.categories.join(", ")}
                          {engine.enabled ? "" : " · off in SearXNG"}
                        </span>
                      </span>
                    </label>
                  ))
                )}
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground text-xs">
                    {visibleEngines.length} of {instance.instance.engines.length} engines shown
                    {usesEveryEngine ? "" : `, ${selected.length} picked`}
                  </span>
                  {usesEveryEngine ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => addEngines(visibleEngines.map((engine) => engine.name))}
                    >
                      Add shown
                    </Button>
                  )}
                </div>
                <label className="flex items-start gap-2">
                  <Checkbox
                    id="show-disabled-engines"
                    checked={showDisabled}
                    onCheckedChange={(checked) => setShowDisabled(checked === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor="show-disabled-engines" className="text-muted-foreground text-xs">
                    Show the engines the instance switched off
                  </Label>
                </label>
              </div>
            </>
          )}
        </div>
      </PageSection>

      <PageSection title="Search defaults">
        <SettingsRow
          htmlFor="search-categories"
          label="Categories"
          description="Used when a search names no engine."
        >
          <MultiSelect
            id="search-categories"
            placeholder="Choose categories"
            searchPlaceholder="Search categories"
            options={categoryOptions}
            value={selectedCategories}
            onChange={setCategories}
            triggerClassName="w-36 sm:w-56"
          />
        </SettingsRow>

        <SettingsRow htmlFor="search-safe-search" label="Safe search">
          <Select
            value={String(safeSearch ?? settings?.webSearchSafeSearch ?? 0)}
            onValueChange={(value) => setSafeSearch(value)}
          >
            <SelectTrigger id="search-safe-search" className="h-8 w-32">
              <SelectValue>
                {SAFE_SEARCH_LABELS[String(safeSearch ?? settings?.webSearchSafeSearch ?? 0)]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SAFE_SEARCH_LABELS).map(([value, labelText]) => (
                <SelectItem key={value} value={value}>
                  {labelText}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow
          htmlFor="search-language"
          label="Language"
          description='Language code a search asks in, such as "en" or "all".'
        >
          <Input
            id="search-language"
            value={language ?? settings?.webSearchLanguage ?? "all"}
            onChange={(event) => setLanguage(event.target.value)}
            className="h-8 w-24 text-sm"
          />
        </SettingsRow>

        <NumberRow
          id="search-results"
          label="Results per search"
          description="How many results a search returns when the model asks for no number."
          value={String(
            resultsPerCall ?? settings?.webSearchResultsPerCall ?? DEFAULT_RESULTS_PER_CALL,
          )}
          onChange={setResultsPerCall}
          min={1}
          max={MAX_RESULTS_PER_CALL}
        />
      </PageSection>

      <PageSection title="Page fetching">
        <NumberRow
          id="fetch-max-chars"
          label="Page length"
          description="Fetched pages are cut to this many characters."
          value={String(maxChars ?? settings?.webFetchMaxChars ?? DEFAULT_MAX_CHARS)}
          onChange={setMaxChars}
          min={MIN_MAX_CHARS}
          max={MAX_MAX_CHARS}
          unit="chars"
        />
        <NumberRow
          id="fetch-timeout"
          label="Timeout"
          description="How long one page fetch may take."
          value={String(timeoutMs ?? settings?.webFetchTimeoutMs ?? 15_000)}
          onChange={setTimeoutMs}
          min={MIN_FETCH_TIMEOUT_MS}
          max={MAX_FETCH_TIMEOUT_MS}
          unit="ms"
        />
        <NumberRow
          id="fetch-redirects"
          label="Redirects"
          description="How many redirects a fetch follows before it gives up."
          value={String(maxRedirects ?? settings?.webFetchMaxRedirects ?? DEFAULT_MAX_REDIRECTS)}
          onChange={setMaxRedirects}
          min={0}
          max={MAX_MAX_REDIRECTS}
        />
      </PageSection>
    </AdminSettingsFrame>
  );
}

/** The pick as it is stored: trimmed, without duplicates, never empty. */
function cleanCategories(values: readonly string[]): string[] {
  const names = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return names.length > 0 ? [...new Set(names)] : [...DEFAULT_SEARCH_CATEGORIES];
}
