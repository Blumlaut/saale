/**
 * Admin branding: the accent colours an instance can carry, and the stylesheet
 * built from them.
 *
 * Only two tokens are brandable. the accent and the ink drawn on it. The
 * surfaces (`--background`, `--card`, `--border`) stay in `globals.css`: they
 * are an elevation ladder, not a brand choice, and a hand-picked step breaks
 * every panel that sits on it.
 *
 * Storage is sparse. A token the admin never touched stays absent, so
 * `globals.css` keeps owning the palette and this module only emits overrides.
 * `DEFAULT_BRAND_COLORS` mirrors those defaults for the pickers;
 * `__tests__/lib/branding/theme.test.ts` reads the CSS and fails on drift.
 */

import { COLOR_MODES, type ColorMode } from "@/lib/theme";

/** The schemes an instance carries its own accents for. */
export const BRAND_MODES = COLOR_MODES;
export type BrandMode = ColorMode;

export interface BrandColorToken {
  key: BrandColorKey;
  label: string;
  description: string;
  /** Custom properties the token sets. */
  variables: readonly string[];
}

export const BRAND_COLOR_KEYS = ["primary", "secondary"] as const;
export type BrandColorKey = (typeof BRAND_COLOR_KEYS)[number];

export const BRAND_COLOR_TOKENS: readonly BrandColorToken[] = [
  {
    key: "primary",
    label: "Primary",
    description: "Primary buttons, active navigation, focus rings, links and the agent mark.",
    variables: ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring", "--chart-1"],
  },
  {
    key: "secondary",
    label: "Secondary",
    description:
      "Text and icons drawn on the accent. Left unset, the readable ink is picked for you. A colour that reads poorly on the accent is shifted until it is legible.",
    variables: ["--primary-foreground", "--sidebar-primary-foreground"],
  },
];

/** The colour each token falls back to, copied from `globals.css`. */
export const DEFAULT_BRAND_COLORS: Record<BrandMode, Record<BrandColorKey, string>> = {
  light: { primary: "#f97316", secondary: "#111827" },
  dark: { primary: "#ff7a2e", secondary: "#0b0b0c" },
};

/** Overrides per mode; an absent token keeps its default. */
export type BrandColors = Record<BrandMode, Partial<Record<BrandColorKey, string>>>;

export const EMPTY_BRAND_COLORS: BrandColors = { light: {}, dark: {} };

// ─── Hex ─────────────────────────────────────────────────────────────────────

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#ABC` and `#AABBCC` both land as `#aabbcc`, or `undefined` when not a colour. */
export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!HEX_PATTERN.test(trimmed)) return undefined;
  const digits = trimmed.slice(1).toLowerCase();
  if (digits.length === 6) return `#${digits}`;
  return `#${digits
    .split("")
    .map((digit) => digit + digit)
    .join("")}`;
}

function linearChannel(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function channels(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex) ?? "#000000";
  return [1, 3, 5].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linearChannel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [brighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (left, right) => right - left,
  ) as [number, number];
  return (brighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for body-sized text, which is what button labels and links are. */
const MIN_CONTRAST = 4.5;

function mixHex(from: string, to: string, amount: number): string {
  const start = channels(from);
  const end = channels(to);
  const blend = (index: 0 | 1 | 2) =>
    Math.round(start[index] + (end[index] - start[index]) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${blend(0)}${blend(1)}${blend(2)}`;
}

/**
 * Ink for a filled accent: whichever of black or white reads better on it, so a
 * dark brand colour does not render black-on-black buttons.
 */
export function readableForeground(hex: string): string {
  return contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#0b0b0c") ? "#ffffff" : "#0b0b0c";
}

/** The ends of the scale, one of which always clears AA. */
const INK_EXTREMES = ["#000000", "#ffffff"] as const;

/**
 * `ink` as it is drawn on `accent`: untouched while it clears AA, else moved
 * toward black or white until it does. The picked hue survives, so a brown ink
 * on an orange accent darkens instead of flipping to white.
 */
export function legibleInk(accent: string, ink: string): string {
  if (contrastRatio(accent, ink) >= MIN_CONTRAST) return ink;

  // Contrast climbs as the mix nears the end of the scale, so the first shade
  // that clears AA is a bisection away.
  const [darkest, lightest] = INK_EXTREMES;
  const extreme =
    contrastRatio(accent, darkest) >= contrastRatio(accent, lightest) ? darkest : lightest;
  let failing = 0;
  let passing = 1;
  for (let step = 0; step < 12; step++) {
    const middle = (failing + passing) / 2;
    if (contrastRatio(accent, mixHex(ink, extreme, middle)) >= MIN_CONTRAST) passing = middle;
    else failing = middle;
  }

  // Rounding can leave the last step short, and pure black or white always clears.
  const adjusted = mixHex(ink, extreme, passing);
  return contrastRatio(accent, adjusted) >= MIN_CONTRAST ? adjusted : extreme;
}

// ─── Column ──────────────────────────────────────────────────────────────────

const TOKEN_KEYS = new Set<string>(BRAND_COLOR_TOKENS.map((token) => token.key));

/** Canonical `themeColors`: known modes, known tokens, valid hex, nothing else. */
export function normalizeThemeColors(value: unknown): BrandColors {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const result: BrandColors = { light: {}, dark: {} };

  for (const mode of BRAND_MODES) {
    const block = source[mode];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const [key, entry] of Object.entries(block as Record<string, unknown>)) {
      if (!TOKEN_KEYS.has(key)) continue;
      const hex = normalizeHex(entry);
      if (hex) result[mode][key as BrandColorKey] = hex;
    }
  }

  return result;
}

/** Whether nothing is overridden, so the column can stay null. */
export function isDefaultBrandColors(colors: BrandColors): boolean {
  return BRAND_MODES.every((mode) => Object.keys(colors[mode]).length === 0);
}

/** Tokens in their effective colours: the override, else the palette default. */
export function resolveBrandColors(colors: BrandColors): Record<BrandMode, Record<string, string>> {
  const resolved = {} as Record<BrandMode, Record<string, string>>;
  for (const mode of BRAND_MODES) {
    resolved[mode] = { ...DEFAULT_BRAND_COLORS[mode], ...colors[mode] };
  }
  return resolved;
}

/**
 * The ink one mode draws on its accent: the picked colour, or the readable one
 * when none is picked, corrected when it would not be legible.
 */
export function accentInk(mode: BrandMode, colors: BrandColors): string {
  const { primary, secondary } = colors[mode];
  const accent = primary ?? DEFAULT_BRAND_COLORS[mode].primary;
  // An untouched accent keeps the palette's own pairing, so the preview and the
  // stylesheet agree on the ink while nothing is overridden.
  const ink =
    secondary ?? (primary ? readableForeground(accent) : DEFAULT_BRAND_COLORS[mode].secondary);
  return legibleInk(accent, ink);
}

// ─── Stylesheet ──────────────────────────────────────────────────────────────

/**
 * The accent overrides, empty when nothing is overridden.
 *
 * The light block is `:root:not(.dark)`: `:root` alone carries the same
 * specificity as `.dark`, and this sheet loads after `globals.css`, so a bare
 * `:root` would paint the light accent in dark mode too.
 */
export function buildBrandingCss(colors: BrandColors): string {
  const blocks: string[] = [];

  for (const mode of BRAND_MODES) {
    const declarations: string[] = [];
    // An accent override carries its ink, even while the ink itself is unset.
    const touchesAccent = Boolean(colors[mode].primary || colors[mode].secondary);

    for (const token of BRAND_COLOR_TOKENS) {
      let value = colors[mode][token.key as BrandColorKey];
      if (token.key === "secondary" && touchesAccent) value = accentInk(mode, colors);
      if (!value) continue;
      for (const variable of token.variables) declarations.push(`${variable}: ${value}`);
    }

    if (declarations.length === 0) continue;
    blocks.push(
      `${mode === "dark" ? ".dark" : ":root:not(.dark)"} {\n  ${declarations.join(";\n  ")};\n}`,
    );
  }

  return blocks.join("\n\n");
}
