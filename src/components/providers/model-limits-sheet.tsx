"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { patchJson } from "@/lib/http";
import { PI_DEFAULT_CONTEXT_WINDOW, PI_DEFAULT_MAX_OUTPUT_TOKENS } from "@/lib/providers/limits";
import {
  DEFAULT_IMAGE_SIZES,
  IMAGE_SIZE_PRESETS,
  MAX_IMAGE_SIZES,
} from "@/lib/providers/images/sizes";

/**
 * One discovered model's token limits.
 *
 * A self-hosted endpoint's models are Pi's to define but not to describe: one
 * server can serve a 4k model and a 128k one, and Pi needs the right window per
 * model to know when to compact. What the user types here applies to that model
 * alone; a field left empty inherits the endpoint's default.
 */

/** The model whose limits are being edited, and everything prefilled for it. */
export interface ModelLimitsTarget {
  provider: string;
  providerName: string;
  modelId: string;
  modelName: string;
  /** What Pi sends today, resolved from every source. */
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** What the user recorded for this model. empty fields inherit. */
  overrides?: { contextWindow?: number; maxOutputTokens?: number } | undefined;
  /**
   * Whether the endpoint takes a picture to edit, when the user said it does
   * not. Absent means it does, which is what the images API assumes.
   */
  imageInput?: boolean | undefined;
  /** The endpoint-wide default the model falls back to. */
  endpointLimits: { contextWindow: number | null; maxOutputTokens: number | null } | null;
  /** Whether this model renders pictures, which is what resolutions are for. */
  image?: boolean | undefined;
  /**
   * The resolutions recorded for this image model; absent means the default
   * list applies.
   */
  imageSizes?: string[] | undefined;
}

export interface ModelLimitsSheetProps {
  target: ModelLimitsTarget | null;
  onOpenChange: (open: boolean) => void;
  /** `/api/providers/capabilities`, or the admin equivalent. */
  capabilitiesEndpoint: string;
  /** Called after a save so the caller can reload what it shows. */
  onSaved: () => void;
  /**
   * Whether this editor may set the model's resolutions. The admin owns them:
   * the list describes what the endpoint renders, and the agent picks from it.
   */
  allowImageSizes?: boolean;
}

/** What the endpoint falls back to per field, for the placeholders. */
function inherited(
  target: ModelLimitsTarget,
  field: "contextWindow" | "maxOutputTokens",
): number | undefined {
  const endpointValue = target.endpointLimits?.[field];
  if (typeof endpointValue === "number") return endpointValue;
  return field === "contextWindow" ? PI_DEFAULT_CONTEXT_WINDOW : PI_DEFAULT_MAX_OUTPUT_TOKENS;
}

/** The size a render uses when the agent names none. */
function firstSize(sizes: readonly string[]): string {
  return (sizes[0] ?? DEFAULT_IMAGE_SIZES[0]!).replace("x", "×");
}

/** A limit the user typed: `undefined` when empty, null when unusable. */
function typed(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function ModelLimitsSheet({
  target,
  onOpenChange,
  capabilitiesEndpoint,
  onSaved,
  allowImageSizes = false,
}: ModelLimitsSheetProps) {
  const [contextWindow, setContextWindow] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [imageInput, setImageInput] = useState(true);
  const [imageSizes, setImageSizes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open starts from what is stored, so closing without saving changes
  // nothing.
  useEffect(() => {
    if (!target) return;
    setContextWindow(target.overrides?.contextWindow ? String(target.overrides.contextWindow) : "");
    setMaxOutputTokens(
      target.overrides?.maxOutputTokens ? String(target.overrides.maxOutputTokens) : "",
    );
    setImageInput(target.imageInput !== false);
    setImageSizes(target.imageSizes ?? []);
    setError(null);
  }, [target]);

  if (!target) return null;

  const context = typed(contextWindow);
  const output = typed(maxOutputTokens);
  const invalid = context === null || output === null;
  const inverted =
    typeof context === "number" && typeof output === "number" && output > context
      ? "The output cap cannot exceed the context window."
      : null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await patchJson(capabilitiesEndpoint, {
        provider: target.provider,
        modelId: target.modelId,
        contextWindow: context ?? null,
        maxOutputTokens: output ?? null,
        imageInput,
        ...(allowImageSizes && target.image ? { imageSizes } : {}),
      });
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error("Failed to save model limits:", err);
      setError(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  };

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:w-[420px] sm:max-w-none">
        <div className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="shrink-0 border-b px-4 pt-4 pb-3">
            <SheetTitle className="text-base leading-tight font-semibold">Model limits</SheetTitle>
            <SheetDescription className="text-muted-foreground text-xs break-all">
              {target.modelName} · {target.providerName}
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="model-context-window">
                  Context window
                </Label>
                <Input
                  id="model-context-window"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder={String(inherited(target, "contextWindow"))}
                  value={contextWindow}
                  onChange={(event) => setContextWindow(event.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="model-max-output">
                  Max output tokens
                </Label>
                <Input
                  id="model-max-output"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder={String(inherited(target, "maxOutputTokens"))}
                  value={maxOutputTokens}
                  onChange={(event) => setMaxOutputTokens(event.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            </div>

            <p className="text-muted-foreground text-[11px]">
              Pi compacts a conversation against these numbers and sends the output cap as the
              request&apos;s token budget, so they have to describe this model on this endpoint. An
              empty field inherits the endpoint&apos;s default.
            </p>

            {/* A diffusion model is offered a reference picture only when the
                endpoint serves /v1/images/edits for it. */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="min-w-0">
                <Label className="text-xs" htmlFor="model-image-input">
                  Takes a picture to edit
                </Label>
                <p className="text-muted-foreground text-[11px]">
                  Off turns image editing off for this model: the agent is only offered a prompt.
                </p>
              </div>
              <Switch
                id="model-image-input"
                checked={imageInput}
                onCheckedChange={setImageInput}
                aria-label="This model takes a picture to edit"
              />
            </div>

            {/* What the model may render at. The agent picks one of these per
                request; the first is what it uses when it picks none. */}
            {allowImageSizes && target.image ? (
              <div className="space-y-1.5 pt-1">
                <Label className="text-xs" htmlFor="model-image-sizes">
                  Resolutions
                </Label>
                <MultiSelect
                  id="model-image-sizes"
                  options={IMAGE_SIZE_PRESETS.map((preset) => ({
                    value: preset.value,
                    label: preset.label,
                  }))}
                  value={imageSizes}
                  onChange={setImageSizes}
                  max={MAX_IMAGE_SIZES}
                  placeholder="Pick resolutions"
                  searchPlaceholder="Search resolutions"
                />
                <p className="text-muted-foreground text-[11px]">
                  {imageSizes.length > 0
                    ? `The agent picks one per request and uses ${firstSize(imageSizes)} by default.`
                    : `No list, so a render uses ${firstSize(DEFAULT_IMAGE_SIZES)}.`}
                </p>
              </div>
            ) : null}

            <p className="text-muted-foreground text-[11px] tabular-nums">
              Now sending {target.contextWindow?.toLocaleString() ?? ""} context /{" "}
              {target.maxOutputTokens?.toLocaleString() ?? ""} output
            </p>

            {(invalid || inverted) && (
              <p className="flex items-center gap-1.5 text-xs text-red-500">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {inverted ?? "Limits must be positive integers."}
              </p>
            )}
            {error && (
              <p className="flex items-center gap-1.5 text-xs text-red-500">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
              </p>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-3">
            <Button
              size="sm"
              className="h-8"
              onClick={() => void save()}
              disabled={saving || invalid || inverted !== null}
            >
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
            {(target.overrides?.contextWindow || target.overrides?.maxOutputTokens) && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                disabled={saving}
                onClick={() => {
                  setContextWindow("");
                  setMaxOutputTokens("");
                }}
              >
                Reset to defaults
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
