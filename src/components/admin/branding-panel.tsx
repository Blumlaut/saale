"use client";

import { useEffect, useRef, useState } from "react";
import { GlassPanel, GlassPanelContent, GlassPanelHeader } from "@/components/ui/glass-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme } from "next-themes";
import { AgentAvatar } from "@/components/brand/agent-avatar";
import { fetchJson } from "@/lib/http";
import {
  accentInk,
  BRAND_COLOR_TOKENS,
  BRAND_MODES,
  DEFAULT_BRAND_COLORS,
  normalizeHex,
  type BrandColorKey,
  type BrandColors,
  type BrandMode,
} from "@/lib/branding/theme";
import { cn } from "@/lib/utils";
import { ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

const MODE_LABELS: Record<BrandMode, string> = { light: "Light", dark: "Dark" };

/** A hex colour: swatch picker, typed hex, and a reset back to the palette. */
function ColorField({
  id,
  label,
  name,
  value,
  overridden,
  onChange,
  onReset,
}: {
  id: string;
  /** The mode this field holds the colour for. */
  label: string;
  /** The token, so the controls read "Primary light" rather than "Light". */
  name: string;
  value: string;
  overridden: boolean;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState(value);

  // The stored value changes under the field when a colour is reset.
  useEffect(() => setDraft(value), [value]);

  const commit = (raw: string) => {
    setDraft(raw);
    const hex = normalizeHex(raw);
    if (hex && hex !== value) onChange(hex);
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${name} ${label} colour`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-input h-8 w-8 shrink-0 cursor-pointer rounded-lg border bg-transparent"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <Input
          id={id}
          value={draft}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-xs"
          onChange={(event) => commit(event.target.value)}
          onBlur={() => setDraft(value)}
        />
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Reset ${name} ${label}`}
        className="text-muted-foreground mt-5 h-7 w-7 shrink-0"
        disabled={!overridden}
        onClick={onReset}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/**
 * The accent colours of one mode, drawn on a small console.
 *
 * The wrapper carries the mode's `dark` class and the drafted accent, so the
 * preview paints the mode the toggle names rather than the one the admin's
 * browser happens to use.
 */
function BrandPreview({ mode, colors }: { mode: BrandMode; colors: BrandColors }) {
  const primary = colors[mode].primary ?? DEFAULT_BRAND_COLORS[mode].primary;
  const ink = accentInk(colors[mode]) ?? DEFAULT_BRAND_COLORS[mode].secondary;

  return (
    <div
      // `text-foreground` sits on the island itself: colour inherits as a value,
      // so without it the preview would keep the surrounding page's ink.
      className={cn("bg-background text-foreground rounded-lg border p-3", mode)}
      style={
        {
          "--primary": primary,
          "--primary-foreground": ink,
          "--ring": primary,
          "--sidebar-primary": primary,
          "--sidebar-primary-foreground": ink,
          "--chart-1": primary,
        } as React.CSSProperties
      }
    >
      <div className="bg-card border-border rounded-lg border">
        <div className="border-border flex items-center justify-between border-b px-3 py-2">
          <span className="flex items-center gap-1.5">
            <AgentAvatar className="h-4 w-4" markClassName="h-3.5 w-3.5" />
            <span className="text-foreground text-sm font-semibold">Saale</span>
          </span>
          <span className="text-primary text-xs font-medium">Active</span>
        </div>
        <div className="space-y-2 px-3 py-2.5">
          <p className="text-foreground text-xs">
            Ask me anything. <span className="text-primary underline">a link in the accent</span>
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-7 text-xs">
              Primary
            </Button>
            <Button variant="secondary" size="sm" className="h-7 text-xs">
              Secondary
            </Button>
            <span className="border-ring ring-ring/50 rounded-md border px-1.5 py-0.5 text-[10px] ring-[3px]">
              focus
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export interface BrandingPanelProps {
  colors: BrandColors;
  onColorsChange: (colors: BrandColors) => void;
  /** File name of the uploaded avatar, empty for the built-in mark. */
  avatar: string;
  onAvatarChange: (fileName: string) => void;
}

/** Admin branding: the agent avatar and the accent colours, with a live preview. */
export function BrandingPanel({
  colors,
  onColorsChange,
  avatar,
  onAvatarChange,
}: BrandingPanelProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // The preview opens in the mode the admin is looking at, and switches on its own.
  const { resolvedTheme } = useTheme();
  const [previewOverride, setPreviewOverride] = useState<BrandMode | null>(null);
  const previewMode = previewOverride ?? (resolvedTheme === "dark" ? "dark" : "light");

  const setToken = (mode: BrandMode, key: BrandColorKey, hex: string | undefined) => {
    const next: BrandColors = { light: { ...colors.light }, dark: { ...colors.dark } };
    if (hex) next[mode][key] = hex;
    else delete next[mode][key];
    onColorsChange(next);
  };

  const resetColors = () => onColorsChange({ light: {}, dark: {} });

  const upload = async (file: File) => {
    setUploading(true);
    const form = new FormData();
    form.set("file", file);
    try {
      const data = await fetchJson<{ settings: { brandingAvatar: string } }>(
        "/api/admin/branding/avatar",
        { method: "POST", body: form },
      );
      onAvatarChange(data.settings.brandingAvatar);
      toast.success("Agent avatar updated");
    } catch (err) {
      console.error("Failed to upload the agent avatar:", err);
      toast.error(err instanceof Error ? err.message : "Failed to upload the image");
    }
    setUploading(false);
  };

  const clearAvatar = async () => {
    setUploading(true);
    try {
      const data = await fetchJson<{ settings: { brandingAvatar: string } }>(
        "/api/admin/branding/avatar",
        { method: "DELETE" },
      );
      onAvatarChange(data.settings.brandingAvatar);
      toast.success("Agent avatar removed");
    } catch (err) {
      console.error("Failed to remove the agent avatar:", err);
      toast.error("Failed to remove the avatar");
    }
    setUploading(false);
  };

  return (
    <GlassPanel>
      <GlassPanelHeader
        title="Branding"
        action={
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={resetColors}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            Defaults
          </Button>
        }
      />
      <GlassPanelContent className="p-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <Label className="text-sm font-medium">Agent avatar</Label>
            <p className="text-muted-foreground text-xs">
              Shown beside every reply, in place of the built-in mark. Square images work best.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AgentAvatar
              className="border-border h-9 w-9 rounded-lg border"
              markClassName="h-5 w-5"
              version={avatar}
            />
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(file);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="mr-1 h-3.5 w-3.5" />
              )}
              {avatar ? "Replace" : "Upload"}
            </Button>
            {avatar && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Remove the agent avatar"
                className="text-muted-foreground h-8 w-8"
                disabled={uploading}
                onClick={() => void clearAvatar()}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <Separator />

        <div className="space-y-4 px-4 py-3">
          {BRAND_COLOR_TOKENS.map((token) => (
            <div key={token.key} className="space-y-2">
              <div className="min-w-0">
                <Label className="text-sm font-medium">{token.label}</Label>
                <p className="text-muted-foreground text-xs">{token.description}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {BRAND_MODES.map((mode) => (
                  <ColorField
                    key={mode}
                    id={`brand-${mode}-${token.key}`}
                    label={MODE_LABELS[mode]}
                    name={token.label}
                    value={colors[mode][token.key] ?? DEFAULT_BRAND_COLORS[mode][token.key]}
                    overridden={Boolean(colors[mode][token.key])}
                    onChange={(hex) => setToken(mode, token.key, hex)}
                    onReset={() => setToken(mode, token.key, undefined)}
                  />
                ))}
              </div>
            </div>
          ))}
          <p className="text-muted-foreground text-xs">
            Takes effect when you save the page. Panels, borders and text keep their palette.
          </p>
        </div>

        <Separator />

        <div className="space-y-2 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">Preview</p>
            <Tabs
              value={previewMode}
              onValueChange={(value) => setPreviewOverride(value as BrandMode)}
            >
              <TabsList>
                {BRAND_MODES.map((mode) => (
                  <TabsTrigger key={mode} value={mode} className="px-2 text-xs">
                    {MODE_LABELS[mode]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <BrandPreview mode={previewMode} colors={colors} />
        </div>
      </GlassPanelContent>
    </GlassPanel>
  );
}
