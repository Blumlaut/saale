/**
 * The resolutions an image render may use.
 *
 * A diffusion server renders whatever it is asked for, and the size it picks on
 * its own is the one nobody chose: stable-diffusion.cpp answers a request with
 * no `size` at 512×512, which is far below what the model is trained on. So an
 * account owns a list of sizes, the first one is the default, and the agent can
 * pick any of the others when the request needs a different shape.
 *
 * Pure data, so the settings form and the server read the same list.
 */

/** One entry of the account's list: the value an endpoint takes, and its label. */
export interface ImageSizePreset {
  /** `WxH`, as the OpenAI images API spells it. */
  value: string;
  label: string;
}

/**
 * The sizes the settings form offers, in the order it shows them.
 *
 * 1024×1024 first because it is what every OpenAI-compatible images endpoint
 * accepts; the 2K entries are what Qwen-Image and friends are trained on, and
 * the pair below them are the aspect ratios a phone screen or a slide needs.
 */
export const IMAGE_SIZE_PRESETS: readonly ImageSizePreset[] = [
  { value: "1024x1024", label: "1024 × 1024 · square" },
  { value: "512x512", label: "512 × 512 · square, fast" },
  { value: "768x768", label: "768 × 768 · square" },
  { value: "1024x1536", label: "1024 × 1536 · portrait" },
  { value: "1536x1024", label: "1536 × 1024 · landscape" },
  { value: "1536x2752", label: "1536 × 2752 · phone" },
  { value: "2752x1536", label: "2752 × 1536 · widescreen" },
  { value: "2048x2048", label: "2048 × 2048 · large square" },
];

/** What a render uses when the account never picked a list. */
export const DEFAULT_IMAGE_SIZES: readonly string[] = ["1024x1024"];

/** Sizes one account may offer: enough for the shapes, short enough to choose from. */
const MAX_IMAGE_SIZES = 6;

/** `1024x1024`: two sides, no units, no sign. */
const SIZE_PATTERN = /^(\d{1,5})x(\d{1,5})$/;

/** Smallest and largest side every endpoint here accepts. */
const MIN_SIDE = 64;
const MAX_SIDE = 4096;

/** Whether a string is a `WxH` an image endpoint will accept. */
export function isImageSize(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SIZE_PATTERN.exec(value);
  if (!match) return false;

  const width = Number(match[1]);
  const height = Number(match[2]);
  return (
    width >= MIN_SIDE &&
    width <= MAX_SIDE &&
    height >= MIN_SIDE &&
    height <= MAX_SIDE &&
    width % 8 === 0 &&
    height % 8 === 0
  );
}

/**
 * A list of sizes, cleaned up: valid entries only, in the caller's order,
 * without repeats, capped. An empty result means "no choice", which is the
 * default list rather than no render at all.
 */
export function normalizeImageSizes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const sizes: string[] = [];

  for (const entry of raw) {
    const size = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!isImageSize(size) || sizes.includes(size)) continue;
    sizes.push(size);
    if (sizes.length === MAX_IMAGE_SIZES) break;
  }

  return sizes.length > 0 ? sizes : [...DEFAULT_IMAGE_SIZES];
}

/** The size a render uses, out of the account's list, when the agent names one. */
export function pickImageSize(sizes: readonly string[], requested?: unknown): string {
  const list = normalizeImageSizes(sizes);
  const wanted = typeof requested === "string" ? requested.trim().toLowerCase() : "";
  return list.find((size) => size === wanted) ?? list[0]!;
}

/** `1024x1024` as the two numbers a card needs to hold the right shape. */
export function imageSizeParts(size: string): { width: number; height: number } | undefined {
  const match = SIZE_PATTERN.exec(size);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}
