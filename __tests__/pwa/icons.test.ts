import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import sharp from "sharp";

import brand from "@/lib/pwa/brand.json";

/**
 * Brand-token contract between the PWA metadata and the stylesheet.
 *
 * The manifest and the `viewport` export cannot read CSS custom properties, so
 * the palette is duplicated in `brand.json`. These tests are the guardrail
 * against the two drifting apart, plus a pixel-level check that the maskable
 * icon really keeps its mark inside the safe zone the platforms crop to.
 */

const ROOT = join(__dirname, "../..");
const GLOBALS_CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");

/** Reads `--<token>` out of a single top-level rule, e.g. `:root` or `.dark`. */
function cssToken(selector: string, token: string): string {
  const escaped = selector.replace(/[.:]/g, "\\$&");
  const block = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(GLOBALS_CSS)?.[1];
  if (block === undefined) throw new Error(`No ${selector} rule found in globals.css`);

  const value = new RegExp(`--${token}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
  if (value === undefined) throw new Error(`--${token} is not defined in ${selector}`);
  return value;
}

/** Distance from the icon centre of the furthest non-background pixel. */
async function markExtent(file: string) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: size, channels } = info;
  const background = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];

  const centre = size / 2;
  let markPixels = 0;
  let furthest = 0;
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * channels;
      const delta =
        Math.abs((data[at] ?? 0) - background[0]!) +
        Math.abs((data[at + 1] ?? 0) - background[1]!) +
        Math.abs((data[at + 2] ?? 0) - background[2]!);
      if (delta <= 24) continue;

      markPixels++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      furthest = Math.max(furthest, Math.hypot(x + 0.5 - centre, y + 0.5 - centre));
    }
  }

  return { size, markPixels, furthest, glyphHeight: maxY - minY + 1, glyphWidth: maxX - minX + 1 };
}

describe("brand tokens", () => {
  it("keeps the manifest theme colours in sync with the stylesheet", () => {
    expect(brand.themeColor.light).toBe(cssToken(":root", "background"));
    expect(brand.themeColor.dark).toBe(cssToken(".dark", "background"));
  });

  it("keeps the icon accent in sync with the dark-theme primary colour", () => {
    expect(brand.accentColor).toBe(cssToken(".dark", "primary"));
  });

  it("paints the install splash on the same ground as the icons", () => {
    expect(brand.backgroundColor).toBe(brand.iconBackground);
    expect(brand.backgroundColor).toBe(cssToken(".dark", "background"));
  });
});

describe("generated icons", () => {
  it("draws a maskable mark that survives an aggressive circular crop", async () => {
    // The maskable safe zone is a circle of radius 40% of the icon size.
    const safeRadius = 0.4;

    for (const size of [192, 512]) {
      const icon = await markExtent(join(ROOT, `public/icons/maskable-${size}.png`));

      expect(icon.markPixels).toBeGreaterThan(0);
      expect(icon.furthest / icon.size).toBeLessThanOrEqual(safeRadius);
    }
  });

  it("draws a legible, larger mark on the un-cropped icons", async () => {
    for (const size of [192, 512]) {
      const icon = await markExtent(join(ROOT, `public/icons/icon-${size}.png`));

      expect(icon.markPixels).toBeGreaterThan(0);
      expect(icon.glyphHeight / icon.size).toBeGreaterThan(0.4);
      expect(icon.glyphWidth / icon.size).toBeLessThan((icon.glyphHeight / icon.size) * 0.75);
    }
  });

  it("keeps the maskable mark smaller than the un-cropped one", async () => {
    const maskable = await markExtent(join(ROOT, "public/icons/maskable-512.png"));
    const any = await markExtent(join(ROOT, "public/icons/icon-512.png"));

    expect(maskable.glyphHeight).toBeLessThan(any.glyphHeight);
  });
});
