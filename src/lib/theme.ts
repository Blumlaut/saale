/**
 * The colour schemes the console offers and the palette each one paints.
 *
 * A renderer that carries its own colours (Monaco, xterm, sonner) asks for a
 * mode here rather than comparing a theme name, so a scheme added to
 * `THEME_NAMES` reaches every surface at once. `globals.css` owns the tokens
 * each mode paints with.
 */

export const COLOR_MODES = ["light", "dark"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const THEME_NAMES = ["light", "dark", "system"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const DEFAULT_THEME: ThemeName = "system";

/**
 * The palette each scheme paints. `system` follows the OS, which next-themes
 * resolves to `light` or `dark` before a theme name reaches us. The record is
 * exhaustive, so a new scheme has to name its palette.
 */
const THEME_MODES: Record<ThemeName, ColorMode | undefined> = {
  light: "light",
  dark: "dark",
  system: undefined,
};

/** The palette a resolved scheme paints. An unknown name paints light. */
export function colorModeOf(theme: string | undefined): ColorMode {
  const mode = theme ? THEME_MODES[theme as ThemeName] : undefined;
  return mode ?? "light";
}
