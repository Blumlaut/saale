"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GlassPanel, GlassPanelContent } from "@/components/ui/glass-panel";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ModelPicker } from "@/components/shared/model-picker";
import {
  ModelLimitsSheet,
  type ModelLimitsTarget,
} from "@/components/providers/model-limits-sheet";
import { getAllPurposes, type ModelPurpose } from "@/lib/pi/purposes";
import { DEFAULT_THINKING_LEVEL_SETTING, thinkingLevelOptionsFor } from "@/lib/pi/thinking-levels";
import { useModelThinkingLevels } from "@/hooks/use-thinking-levels";
import { fetchJson, patchJson } from "@/lib/http";
import { cn } from "@/lib/utils";
import { Brain, ChevronDown, Eye, Loader2, RotateCcw, SlidersHorizontal } from "lucide-react";
import { SaveFooter } from "../components/save-footer";
import { ProviderManagement } from "../components/provider-management";
import { useUserSettings } from "../components/user-settings-provider";
import type { AvailableModel, AvailableProvider, UserSettings } from "../types";

interface FullModelInfo extends AvailableModel {
  provider: string;
  providerName: string;
}

/** What a model without its own limits inherits from the endpoint. */
interface EndpointLimits {
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

/** The look both dropdowns on this page share. */
const CONTROL_TRIGGER =
  "h-8 w-full justify-between rounded-lg border pr-2 pl-2.5 text-sm font-normal dark:bg-input/30";

/** `provider/model`, the form the stored selection and the pickers share. */
function modelValue(selection: { provider?: string; model?: string } | null | undefined): string {
  return selection?.provider && selection.model ? `${selection.provider}/${selection.model}` : "";
}

function splitModelValue(value: string): { provider: string; model: string } | null {
  if (!value) return null;
  const [provider, ...modelParts] = value.split("/");
  const model = modelParts.join("/");
  return provider && model ? { provider, model } : null;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
  }
  return String(tokens);
}

/**
 * Settings → Models.
 *
 * The choice per task comes first: one searchable picker each, with the default
 * as the fallback. The inventory (every model of every provider) is a secondary
 * concern, so it sits folded away at the bottom.
 */
export function ModelsSection() {
  const { settings, updateSettings, saving, saveStatus, save } = useUserSettings();
  const purposes = useMemo(() => getAllPurposes(), []);

  // The inventory lives below, and is only fetched once someone opens it.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [allModels, setAllModels] = useState<FullModelInfo[]>([]);
  const [search, setSearch] = useState("");
  const [savingVision, setSavingVision] = useState<string | null>(null);
  const [limitsTarget, setLimitsTarget] = useState<ModelLimitsTarget | null>(null);
  /** Endpoint provider id → the defaults its models fall back to. */
  const [endpointLimits, setEndpointLimits] = useState<Record<string, EndpointLimits>>({});
  const [configurableProviders, setConfigurableProviders] = useState<Set<string>>(new Set());
  /** Bumped when providers change, so the pickers drop their cached list. */
  const [pickerKey, setPickerKey] = useState(0);

  const loadInventory = useCallback(async () => {
    try {
      const data = await fetchJson<{
        models: Record<string, AvailableModel[]>;
        providers?: AvailableProvider[];
        endpointLimits?: Record<string, EndpointLimits>;
      }>("/api/providers/models?includeDisabled=true");

      const all: FullModelInfo[] = [];
      for (const [provider, modelsList] of Object.entries(data.models ?? {})) {
        const providerName =
          (data.providers ?? []).find((p) => p.id === provider)?.name ?? provider;
        for (const model of modelsList) {
          all.push({ ...model, provider, providerName });
        }
      }
      all.sort((a, b) => a.name.localeCompare(b.name));

      setAllModels(all);
      setEndpointLimits(data.endpointLimits ?? {});
      setConfigurableProviders(
        new Set((data.providers ?? []).filter((p) => p.modelsConfigurable).map((p) => p.id)),
      );
      setInventoryLoaded(true);
    } catch (err) {
      console.error("Failed to load the model list:", err);
    }
  }, []);

  useEffect(() => {
    if (advancedOpen && !inventoryLoaded) void loadInventory();
  }, [advancedOpen, inventoryLoaded, loadInventory]);

  const defaultModel = modelValue(
    settings ? { provider: settings.defaultModelProvider, model: settings.defaultModelName } : null,
  );
  const defaultSelection = splitModelValue(defaultModel);
  const currentLevel = settings?.defaultThinkingLevel || DEFAULT_THINKING_LEVEL_SETTING;
  const thinking = useModelThinkingLevels(
    defaultSelection?.provider,
    defaultSelection?.model,
    currentLevel,
  );
  const thinkingOptions = thinkingLevelOptionsFor(thinking.levels);

  const update = (patch: Partial<UserSettings>) => {
    if (settings) updateSettings({ ...settings, ...patch });
  };

  const setDefaultModel = (value: string) => {
    const next = splitModelValue(value);
    update({
      defaultModelProvider: next?.provider ?? "",
      defaultModelName: next?.model ?? "",
    });
  };

  const setPurposeModel = (purpose: ModelPurpose, value: string) => {
    if (!settings) return;
    const overrides = { ...(settings.purposeModelOverrides ?? {}) };
    const next = splitModelValue(value);

    if (!next) {
      delete overrides[purpose.id];
    } else {
      overrides[purpose.id] = next;
    }

    update({
      purposeModelOverrides: Object.keys(overrides).length > 0 ? overrides : null,
    });
  };

  /** Hide or show one model in every picker. */
  const toggleModelShown = (provider: string, modelId: string) => {
    if (!settings) return;
    const key = `${provider}:${modelId}`;
    const current = settings.disabledModels ?? [];
    const updated = current.includes(key)
      ? current.filter((entry) => entry !== key)
      : [...current, key];

    update({ disabledModels: updated.length > 0 ? updated : null });
  };

  /** Hide or show a provider's models: the ones on screen when a search is on. */
  const toggleProviderShown = (provider: string, modelIds: string[], shown: boolean) => {
    if (!settings) return;
    const keys = modelIds.map((modelId) => `${provider}:${modelId}`);
    const current = settings.disabledModels ?? [];
    const updated = shown
      ? [...new Set([...current.filter((entry) => !keys.includes(entry)), ...keys])]
      : current.filter((entry) => !keys.includes(entry));

    update({ disabledModels: updated.length > 0 ? updated : null });
  };

  const toggleVision = async (provider: string, modelId: string, vision: boolean) => {
    const key = `${provider}:${modelId}`;
    setSavingVision(key);
    try {
      await patchJson("/api/providers/capabilities", { provider, modelId, vision });
      await loadInventory();
    } catch (err) {
      console.error("Failed to save whether the model sees images:", err);
    }
    setSavingVision(null);
  };

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const groupsByProvider = new Map<string, { name: string; models: FullModelInfo[] }>();

    for (const model of allModels) {
      if (
        query &&
        !model.name.toLowerCase().includes(query) &&
        !model.id.toLowerCase().includes(query) &&
        !model.providerName.toLowerCase().includes(query)
      ) {
        continue;
      }
      const group = groupsByProvider.get(model.provider) ?? {
        name: model.providerName,
        models: [],
      };
      group.models.push(model);
      groupsByProvider.set(model.provider, group);
    }

    return [...groupsByProvider.entries()];
  }, [allModels, search]);

  if (!settings) return null;

  const defaultLabel = defaultModel
    ? (allModels.find((m) => `${m.provider}/${m.id}` === defaultModel)?.name ??
      defaultSelection?.model)
    : null;

  return (
    <GlassPanel>
      <GlassPanelContent className="space-y-6">
        {/* The fallback everything else inherits */}
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium">Default model</h3>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Used wherever you have not picked something else.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="default-model">Model</Label>
              <div id="default-model">
                <ModelPicker
                  key={`default-${pickerKey}`}
                  value={defaultModel}
                  onChange={setDefaultModel}
                  placeholder="Choose a model"
                  triggerClassName="w-full"
                  className={CONTROL_TRIGGER}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="thinking-level">Thinking</Label>
              <Select
                value={currentLevel}
                onValueChange={(value) => {
                  if (value) update({ defaultThinkingLevel: value });
                }}
              >
                <SelectTrigger id="thinking-level" className={CONTROL_TRIGGER}>
                  <Brain className="text-muted-foreground h-3.5 w-3.5" />
                  <SelectValue>
                    {thinkingOptions.find((option) => option.id === currentLevel)?.label ??
                      currentLevel}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {thinkingOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                {thinking.reasoning === false
                  ? "This model always answers straight away."
                  : thinking.unsupported
                    ? "Not offered by this model; it falls back to its own default."
                    : "How long the model may think before answering."}
              </p>
            </div>
          </div>
        </div>

        <Separator />

        {/* One picker per kind of work */}
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium">Per task</h3>
          </div>

          <div className="divide-y">
            {purposes.map((purpose) => {
              const override = settings.purposeModelOverrides?.[purpose.id];
              const value = modelValue(override);
              const Icon = purpose.icon;

              return (
                <div
                  key={purpose.id}
                  className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{purpose.label}</p>
                      {value === "" && defaultLabel ? (
                        <p className="text-muted-foreground truncate text-xs">
                          Uses {defaultLabel}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex min-w-0 items-center gap-2 sm:shrink-0">
                    <ModelPicker
                      key={`${purpose.id}-${pickerKey}`}
                      value={value}
                      onChange={(next) => setPurposeModel(purpose, next)}
                      placeholder="Same as default"
                      className={cn(CONTROL_TRIGGER, "sm:w-56")}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-8 shrink-0", !value && "invisible")}
                      aria-label={`Use the default model for ${purpose.label}`}
                      tabIndex={value ? 0 : -1}
                      onClick={() => setPurposeModel(purpose, "")}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Separator />

        {/* Your own endpoints. the reason a per-model list exists at all */}
        <div className="space-y-4">
          <div>
            <h3 className="text-base font-medium">Your providers</h3>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Connect your own API keys to reach models the instance does not offer.
            </p>
          </div>
          <ProviderManagement
            onModelsChanged={() => {
              setPickerKey((key) => key + 1);
              setInventoryLoaded(false);
              if (advancedOpen) void loadInventory();
            }}
          />
        </div>

        <Separator />

        {/* Everything else: the inventory, folded away */}
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg text-left">
            <span className="min-w-0">
              <span className="block text-base font-medium">Models</span>
              <span className="text-muted-foreground block text-sm">
                Hide the models you never pick.
              </span>
            </span>
            <ChevronDown
              className={cn(
                "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
                advancedOpen && "rotate-180",
              )}
            />
          </CollapsibleTrigger>

          <CollapsibleContent className="space-y-4 pt-4">
            {!inventoryLoaded ? (
              <div className="flex justify-center py-6">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : allModels.length === 0 ? (
              <p className="text-muted-foreground py-4 text-sm">
                No models yet. Connect a provider above.
              </p>
            ) : (
              <>
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search models…"
                  className="h-8 max-w-xs"
                />

                {groups.length === 0 ? (
                  <p className="text-muted-foreground py-4 text-sm">No models match that search.</p>
                ) : (
                  <div className="space-y-4">
                    {groups.map(([providerKey, group]) => {
                      const shownIds = group.models.map((model) => model.id);
                      const hidden = settings.disabledModels ?? [];
                      const shownCount = shownIds.filter(
                        (id) => !hidden.includes(`${providerKey}:${id}`),
                      ).length;
                      const allShown = shownCount === group.models.length;
                      const filtered = search.trim().length > 0;

                      return (
                        <div key={providerKey}>
                          <div className="flex items-center justify-between gap-2 pb-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="text-muted-foreground truncate text-xs font-medium">
                                {group.name}
                              </span>
                              <span className="text-muted-foreground/60 text-[10px]">
                                {shownCount}/{group.models.length} shown
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <span className="text-muted-foreground text-[10px]">
                                {filtered ? "Shown" : "All"}
                              </span>
                              <Switch
                                checked={allShown}
                                aria-label={
                                  filtered
                                    ? `Show or hide the ${group.models.length} listed models of ${group.name}`
                                    : `Show or hide every model of ${group.name}`
                                }
                                onCheckedChange={(next) =>
                                  toggleProviderShown(providerKey, shownIds, next)
                                }
                              />
                            </div>
                          </div>

                          <div className="divide-y">
                            {group.models.map((model) => {
                              const isHidden = hidden.includes(`${providerKey}:${model.id}`);

                              return (
                                <div
                                  key={model.id}
                                  className={cn(
                                    "flex items-center gap-3 py-2",
                                    isHidden && "opacity-50",
                                  )}
                                >
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="truncate text-sm">{model.name}</span>
                                      {model.reasoning ? (
                                        <Badge
                                          variant="secondary"
                                          className="rounded-full px-1.5 text-[10px]"
                                        >
                                          reasoning
                                        </Badge>
                                      ) : null}
                                      {model.vision ? (
                                        <Badge
                                          variant="outline"
                                          className="gap-1 rounded-full px-1.5 text-[10px] font-normal text-emerald-600 dark:text-emerald-400"
                                        >
                                          <Eye className="h-3 w-3" />
                                          vision
                                        </Badge>
                                      ) : null}
                                    </div>
                                    <span className="text-muted-foreground text-xs">
                                      {model.contextWindow
                                        ? `${formatContextWindow(model.contextWindow)} context`
                                        : model.id}
                                    </span>
                                  </div>

                                  <div className="flex shrink-0 items-center gap-1">
                                    {configurableProviders.has(providerKey) ? (
                                      <>
                                        <Button
                                          variant="ghost"
                                          size="icon-xs"
                                          className="text-muted-foreground/60"
                                          title="Set this model's context window and output cap"
                                          onClick={() =>
                                            setLimitsTarget({
                                              provider: providerKey,
                                              providerName: group.name,
                                              modelId: model.id,
                                              modelName: model.name,
                                              contextWindow: model.contextWindow,
                                              maxOutputTokens: model.maxOutputTokens,
                                              overrides: model.overrides,
                                              endpointLimits: endpointLimits[providerKey] ?? null,
                                            })
                                          }
                                        >
                                          <SlidersHorizontal className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          size="icon-xs"
                                          className={cn(
                                            model.vision
                                              ? "text-emerald-600 dark:text-emerald-400"
                                              : "text-muted-foreground/60",
                                          )}
                                          title={
                                            model.vision
                                              ? "This model can see images"
                                              : "Mark this model as able to see images"
                                          }
                                          disabled={savingVision === `${providerKey}:${model.id}`}
                                          onClick={() =>
                                            void toggleVision(providerKey, model.id, !model.vision)
                                          }
                                        >
                                          {savingVision === `${providerKey}:${model.id}` ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                          ) : (
                                            <Eye className="h-3.5 w-3.5" />
                                          )}
                                        </Button>
                                      </>
                                    ) : null}
                                    <Switch
                                      checked={!isHidden}
                                      aria-label={`Show ${model.name}`}
                                      onCheckedChange={() =>
                                        toggleModelShown(providerKey, model.id)
                                      }
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </CollapsibleContent>
        </Collapsible>
      </GlassPanelContent>

      <ModelLimitsSheet
        target={limitsTarget}
        onOpenChange={(open) => {
          if (!open) setLimitsTarget(null);
        }}
        capabilitiesEndpoint="/api/providers/capabilities"
        onSaved={() => {
          void loadInventory();
        }}
      />

      <SaveFooter saving={saving} saveStatus={saveStatus} onSave={save} />
    </GlassPanel>
  );
}
