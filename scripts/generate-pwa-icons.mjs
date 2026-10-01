#!/usr/bin/env node
/**
 * Renders the PWA icon set from the Saale brand mark.
 *
 * The committed PNG/ICO files in `public/icons`, `src/app/icon.png`,
 * `src/app/apple-icon.png` and `src/app/favicon.ico` are the build artifacts of
 * this script — regenerate them with `npm run pwa:icons` after changing the mark
 * or the palette in `src/lib/pwa/brand.json`.
 *
 * Two rendering modes matter:
 *   - `any`      — full-bleed square; the platform applies its own rounding.
 *   - `maskable` — the mark must survive an aggressive circular crop, so it is
 *                  drawn smaller, inside the 40%-radius maskable safe zone.
 */
/* eslint-disable no-console */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** lucide-react's `chevron-right` glyph, in a 24×24 viewBox. */
const CHEVRON = {
  path: "M9 18l6-6-6-6",
  viewBox: 24,
  /** Visual bounds of the glyph, stroke excluded. */
  width: 6,
  height: 12,
  strokeWidth: 2.25,
};

/**
 * Glyph height as a fraction of the icon size.
 *
 * `maskable` has to stay inside the safe zone: the mark's half-diagonal
 * (including the stroke) must be < 40% of the icon size.
 */
const GLYPH_RATIO = {
  any: 0.45,
  maskable: 0.36,
};

const ICON_SIZES = [192, 512];
const APPLE_ICON_SIZE = 180;
const FAVICON_SIZES = [16, 32, 48];

const brand = JSON.parse(await readFile(path.join(ROOT, "src/lib/pwa/brand.json"), "utf8"));

/** SVG source for one icon. */
function renderSvg({ size, mode }) {
  const glyphHeight = size * GLYPH_RATIO[mode];
  const scale = glyphHeight / CHEVRON.height;
  const offset = (size - CHEVRON.viewBox * scale) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${brand.iconBackground}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">
    <path d="${CHEVRON.path}" fill="none" stroke="${brand.accentColor}" stroke-width="${CHEVRON.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;
}

function renderPng({ size, mode }) {
  return sharp(Buffer.from(renderSvg({ size, mode })))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Packs PNG frames into a multi-size `.ico`.
 *
 * The container is the Vista+ variant: a 6-byte header, one 16-byte directory
 * entry per frame, then the PNG payloads.
 */
function packIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;

  frames.forEach(({ size, png }, index) => {
    const at = index * 16;
    // 256px is encoded as 0 in the single-byte width/height fields.
    directory.writeUInt8(size >= 256 ? 0 : size, at);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...frames.map((frame) => frame.png)]);
}

async function write(target, contents) {
  const absolute = path.join(ROOT, target);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  console.log(`  ${target} (${contents.length} bytes)`);
}

console.log("Generating PWA icons…");

for (const size of ICON_SIZES) {
  await write(`public/icons/icon-${size}.png`, await renderPng({ size, mode: "any" }));
}
for (const size of ICON_SIZES) {
  await write(`public/icons/maskable-${size}.png`, await renderPng({ size, mode: "maskable" }));
}

// Next.js file conventions — auto-linked into <head>.
await write("src/app/icon.png", await renderPng({ size: 512, mode: "any" }));
await write("src/app/apple-icon.png", await renderPng({ size: APPLE_ICON_SIZE, mode: "any" }));

await write(
  "src/app/favicon.ico",
  packIco(
    await Promise.all(
      FAVICON_SIZES.map(async (size) => ({ size, png: await renderPng({ size, mode: "any" }) })),
    ),
  ),
);

console.log("Done.");
