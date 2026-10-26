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

export const BRAND_MODES = ["light", "dark"] as const;
export type BrandMode = (typeof BRAND_MODES)[number];

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
      "Text and icons drawn on the accent. Left unset, the readable ink is picked for you.",
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

function relativeLuminance(hex: string): number {
  const normalized = normalizeHex(hex) ?? "#000000";
  const [r, g, b] = [1, 3, 5].map((offset) =>
    linearChannel(parseInt(normalized.slice(offset, offset + 2), 16)),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Ink for a filled accent: whichever of black or white reads better on it, so a
 * dark brand colour does not render black-on-black buttons.
 */
export function readableForeground(hex: string): string {
  const luminance = relativeLuminance(hex);
  const againstWhite = 1.05 / (luminance + 0.05);
  const againstBlack = (luminance + 0.05) / 0.05;
  return againstWhite >= againstBlack ? "#ffffff" : "#0b0b0c";
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

/** The ink a mode's accent gets when `secondary` is left unset. */
export function accentInk(colors: Partial<Record<BrandColorKey, string>>): string | undefined {
  const primary = colors.primary;
  if (!primary) return undefined;
  return colors.secondary ?? readableForeground(primary);
}

// ─── Stylesheet ──────────────────────────────────────────────────────────────

/**
 * The accent overrides, empty when nothing is overridden.
 *
 * `:root` comes first so the `.dark` block wins in dark mode: both selectors
 * carry the same specificity, and this sheet loads after `globals.css`.
 */
export function buildBrandingCss(colors: BrandColors): string {
  const blocks: string[] = [];

  for (const mode of BRAND_MODES) {
    const declarations: string[] = [];

    for (const token of BRAND_COLOR_TOKENS) {
      let value = colors[mode][token.key as BrandColorKey];
      // The ink is derived only while it is unset, and only once there is an
      // accent to read it from.
      if (token.key === "secondary" && !value) value = accentInk(colors[mode]);
      if (!value) continue;
      for (const variable of token.variables) declarations.push(`${variable}: ${value}`);
    }

    if (declarations.length === 0) continue;
    blocks.push(`${mode === "dark" ? ".dark" : ":root"} {\n  ${declarations.join(";\n  ")};\n}`);
  }

  return blocks.join("\n\n");
}
