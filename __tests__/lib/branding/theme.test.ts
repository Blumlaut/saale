import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  accentInk,
  BRAND_COLOR_TOKENS,
  BRAND_MODES,
  buildBrandingCss,
  contrastRatio,
  DEFAULT_BRAND_COLORS,
  isDefaultBrandColors,
  legibleInk,
  normalizeHex,
  normalizeThemeColors,
  readableForeground,
  resolveBrandColors,
} from "@/lib/branding/theme";

const CSS = readFileSync("src/app/globals.css", "utf8");

/**
 * The palette blocks in globals.css. The light one is declared on `:root` and
 * repeated for `.light`, which is what lets a dark page hold a light island.
 */
const PALETTE_BLOCKS = {
  ":root": /\n:root,\s*\n\.light \{([\s\S]*?)\n\}/,
  ".dark": /\n\.dark \{([\s\S]*?)\n\}/,
};

/** A custom property's value inside one of the palette blocks. */
function cssToken(block: ":root" | ".dark", name: string): string | undefined {
  const body = PALETTE_BLOCKS[block].exec(CSS)?.[1];
  if (!body) throw new Error(`No ${block} block in globals.css`);
  return new RegExp(`${name}:\\s*(#[0-9a-fA-F]+)`).exec(body)?.[1];
}

describe("branding defaults", () => {
  it("mirrors the palette in globals.css", () => {
    for (const mode of BRAND_MODES) {
      const block = mode === "dark" ? ".dark" : ":root";
      expect(cssToken(block, "--primary")).toBe(DEFAULT_BRAND_COLORS[mode].primary);
      expect(cssToken(block, "--primary-foreground")).toBe(DEFAULT_BRAND_COLORS[mode].secondary);
    }
  });

  it("only claims custom properties the palette defines", () => {
    for (const token of BRAND_COLOR_TOKENS) {
      for (const variable of token.variables) {
        expect(cssToken(":root", variable), `:root ${variable}`).toBeDefined();
        expect(cssToken(".dark", variable), `.dark ${variable}`).toBeDefined();
      }
    }
  });
});

describe("hex colours", () => {
  it("accepts shorthand and long form, and lower-cases them", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("  #2563EB ")).toBe("#2563eb");
    expect(normalizeHex("#f97316")).toBe("#f97316");
  });

  it("refuses anything that is not a hex colour", () => {
    for (const value of ["f97316", "#f9731", "#12345", "orange", "rgb(1,2,3)", "", 42, null]) {
      expect(normalizeHex(value), String(value)).toBeUndefined();
    }
  });
});

describe("normalizeThemeColors", () => {
  it("keeps known modes and tokens only", () => {
    const stored = {
      light: { primary: "#ABC", nope: "#ffffff" },
      dark: { secondary: "#000", primary: "not-a-colour" },
      sepia: { primary: "#ffffff" },
    };

    expect(normalizeThemeColors(stored)).toEqual({
      light: { primary: "#aabbcc" },
      dark: { secondary: "#000000" },
    });
  });

  it("reads a missing or malformed column as nothing overridden", () => {
    for (const value of [null, undefined, {}, "nope", [], { light: "nope" }]) {
      expect(normalizeThemeColors(value)).toEqual({ light: {}, dark: {} });
      expect(isDefaultBrandColors(normalizeThemeColors(value))).toBe(true);
    }
  });
});

describe("readableForeground", () => {
  it("draws light ink on a dark accent and dark ink on a light one", () => {
    expect(readableForeground("#111827")).toBe("#ffffff");
    expect(readableForeground("#1d4ed8")).toBe("#ffffff");
    expect(readableForeground("#3b82f6")).toBe("#0b0b0c");
    expect(readableForeground("#f97316")).toBe("#0b0b0c");
    expect(readableForeground("#fde68a")).toBe("#0b0b0c");
  });
});

describe("contrastRatio", () => {
  it("scores black on white at 21 and a colour against itself at 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#f97316", "#F97316")).toBeCloseTo(1, 5);
  });
});

describe("legibleInk", () => {
  it("leaves an ink that already reads alone", () => {
    expect(legibleInk("#2563eb", "#ffffff")).toBe("#ffffff");
    expect(legibleInk("#f97316", "#111827")).toBe("#111827");
  });

  it("darkens a mid-tone ink on a light accent until it clears AA", () => {
    const ink = legibleInk("#f97316", "#fdc99a");

    expect(ink).not.toBe("#fdc99a");
    expect(contrastRatio("#f97316", ink)).toBeGreaterThanOrEqual(4.5);
    // The picked hue survives, so it darkens instead of flipping to white.
    expect(ink).not.toBe("#ffffff");
  });

  it("lightens a dark ink on a dark accent", () => {
    const ink = legibleInk("#111827", "#1f2937");

    expect(ink).not.toBe("#1f2937");
    expect(contrastRatio("#111827", ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps any accent legible, including the mid-greys that sit at the crossover", () => {
    for (const accent of ["#767676", "#808080", "#7f7f7f", "#f97316", "#986a44"]) {
      expect(contrastRatio(accent, legibleInk(accent, accent)), accent).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("resolveBrandColors", () => {
  it("fills untouched tokens from the palette", () => {
    const resolved = resolveBrandColors({ light: { primary: "#2563eb" }, dark: {} });

    expect(resolved.light).toEqual({ primary: "#2563eb", secondary: "#111827" });
    expect(resolved.dark).toEqual(DEFAULT_BRAND_COLORS.dark);
  });
});

describe("buildBrandingCss", () => {
  it("emits nothing while nothing is overridden", () => {
    expect(buildBrandingCss({ light: {}, dark: {} })).toBe("");
  });

  it("writes the accent into every property that carries it", () => {
    const css = buildBrandingCss({ light: { primary: "#2563eb" }, dark: {} });

    expect(css.startsWith(":root:not(.dark) {")).toBe(true);
    expect(css).toContain("--primary: #2563eb");
    expect(css).toContain("--ring: #2563eb");
    expect(css).toContain("--sidebar-primary: #2563eb");
    expect(css).toContain("--chart-1: #2563eb");
    // The ink is derived while secondary is unset.
    expect(css).toContain("--primary-foreground: #ffffff");
    expect(css).not.toContain(".dark {");
  });

  it("puts dark overrides in a .dark block after :root", () => {
    const css = buildBrandingCss({
      light: { primary: "#2563eb" },
      dark: { primary: "#60a5fa" },
    });

    expect(css.indexOf(":root:not(.dark) {")).toBeLessThan(css.indexOf(".dark {"));
    expect(css).toContain("--primary: #60a5fa");
  });

  it("keeps a light override out of dark mode", () => {
    const css = buildBrandingCss({ light: { primary: "#2563eb" }, dark: {} });

    // `:root` alone ties with `.dark` and would win on load order.
    expect(css).not.toMatch(/^:root \{/m);
  });

  it("keeps a secondary the admin picked when it reads on the accent", () => {
    const css = buildBrandingCss({ light: { primary: "#2563eb", secondary: "#f8fafc" }, dark: {} });

    expect(css).toContain("--primary-foreground: #f8fafc");
    expect(css).not.toContain("--primary-foreground: #ffffff");
  });

  it("shifts a secondary that would not read on the accent", () => {
    const css = buildBrandingCss({ light: { primary: "#f97316", secondary: "#fbbf24" }, dark: {} });
    const ink = /--primary-foreground: (#[0-9a-f]{6})/.exec(css)?.[1] ?? "";

    expect(ink).not.toBe("#fbbf24");
    expect(contrastRatio("#f97316", ink)).toBeGreaterThanOrEqual(4.5);
  });

  it("writes a secondary without an accent, checked against the palette accent", () => {
    const css = buildBrandingCss({ light: {}, dark: { secondary: "#111827" } });

    expect(css).toBe(
      ".dark {\n  --primary-foreground: #111827;\n  --sidebar-primary-foreground: #111827;\n}",
    );
  });

  it("still corrects a lone secondary that fails on the palette accent", () => {
    const css = buildBrandingCss({ light: { secondary: "#fde68a" }, dark: {} });
    const ink = /--primary-foreground: (#[0-9a-f]{6})/.exec(css)?.[1] ?? "";

    expect(contrastRatio(DEFAULT_BRAND_COLORS.light.primary, ink)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("accentInk", () => {
  it("follows the accent until the ink is set", () => {
    expect(accentInk("light", { light: { primary: "#2563eb" }, dark: {} })).toBe("#ffffff");
    expect(
      accentInk("light", { light: { primary: "#2563eb", secondary: "#f8fafc" }, dark: {} }),
    ).toBe("#f8fafc");
  });

  it("checks the ink against the palette accent when no accent is set", () => {
    expect(accentInk("dark", { light: {}, dark: {} })).toBe(DEFAULT_BRAND_COLORS.dark.secondary);
    expect(accentInk("light", { light: { secondary: "#f8fafc" }, dark: {} })).not.toBe("#f8fafc");
  });
});
