import { statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import sharp from "sharp";

import manifest from "@/app/manifest";

/**
 * Installability contract.
 *
 * A manifest is only useful if every icon it advertises actually exists at the
 * size it claims  a missing or mis-sized icon is the classic reason a browser
 * silently refuses to offer installation. So the declared sizes are verified
 * against the real PNG dimensions on disk rather than trusted.
 */

const PUBLIC_DIR = join(__dirname, "../../public");

const MANIFEST = manifest();
const ICONS = MANIFEST.icons ?? [];

function parseSizes(sizes: string | undefined): [number, number] {
  const match = /^(\d+)x(\d+)$/.exec(sizes ?? "");
  if (!match) throw new Error(`Unparseable icon size: ${sizes}`);
  return [Number(match[1]), Number(match[2])];
}

describe("web app manifest", () => {
  it("declares the fields browsers require to offer installation", () => {
    expect(MANIFEST.name).toBeTruthy();
    expect(MANIFEST.short_name).toBeTruthy();
    expect(MANIFEST.start_url).toBe("/");
    expect(MANIFEST.display).toBe("standalone");
    expect(MANIFEST.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(MANIFEST.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("keeps start_url inside the declared scope", () => {
    const scope = MANIFEST.scope ?? "/";
    expect(String(MANIFEST.start_url).startsWith(scope)).toBe(true);
  });

  it("ships the 192px + 512px icon pair Chrome requires", () => {
    const anySizes = ICONS.filter((icon) => icon.purpose !== "maskable").map((icon) =>
      parseSizes(icon.sizes),
    );

    expect(anySizes).toContainEqual([192, 192]);
    expect(anySizes).toContainEqual([512, 512]);
  });

  it("ships a maskable icon so Android can crop it into any shape", () => {
    const maskable = ICONS.filter((icon) => icon.purpose === "maskable");

    expect(maskable.length).toBeGreaterThan(0);
    expect(
      maskable.some((icon) => {
        const [width, height] = parseSizes(icon.sizes);
        return width >= 512 && height >= 512;
      }),
    ).toBe(true);
  });

  it.each(ICONS.map((icon) => [icon.src, icon.sizes, icon.type] as const))(
    "%s exists as a %s %s image",
    async (src, sizes, type) => {
      expect(src?.startsWith("/")).toBe(true);

      const file = join(PUBLIC_DIR, src!);
      expect(statSync(file).isFile()).toBe(true);

      const metadata = await sharp(file).metadata();
      const [width, height] = parseSizes(sizes);

      expect(metadata.format).toBe("png");
      expect(type).toBe("image/png");
      expect([metadata.width, metadata.height]).toEqual([width, height]);
    },
  );

  it("exposes shortcuts that point at real dashboard routes", () => {
    const shortcuts = MANIFEST.shortcuts ?? [];

    expect(shortcuts.length).toBeGreaterThan(0);
    for (const shortcut of shortcuts) {
      expect(shortcut.url).toMatch(/^\/dashboard\/[a-z]+$/);
      expect(shortcut.name).toBeTruthy();
    }
  });
});
