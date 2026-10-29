import type { ITheme } from "@xterm/xterm";

/**
 * The terminal's colours.
 *
 * The console tokens cover the surface and the text, but a terminal also needs
 * the sixteen ANSI colours a program picks from, which no token defines: they
 * come from a palette tuned to stay readable on our own background.
 */

/** The sixteen colours a program picks from, in order. */
type AnsiPalette = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** ANSI 0-15 on the light theme: dark enough to read on near-white. */
const ANSI_LIGHT: AnsiPalette = [
  "#111827",
  "#c2410c",
  "#15803d",
  "#a16207",
  "#1d4ed8",
  "#a21caf",
  "#0e7490",
  "#6b7280",
  "#374151",
  "#ea580c",
  "#16a34a",
  "#ca8a04",
  "#2563eb",
  "#c026d3",
  "#0891b2",
  "#9ca3af",
];

/** ANSI 0-15 on the dark theme: bright enough to read on near-black. */
const ANSI_DARK: AnsiPalette = [
  "#3f3f46",
  "#ff7a2e",
  "#4ade80",
  "#facc15",
  "#60a5fa",
  "#e879f9",
  "#22d3ee",
  "#d4d4d8",
  "#71717a",
  "#fb923c",
  "#86efac",
  "#fde047",
  "#93c5fd",
  "#f0abfc",
  "#67e8f9",
  "#f5f5f7",
];

function token(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback;
}

/** Read the console's own tokens so the terminal sits on the panel, not beside it. */
export function terminalTheme(styles: CSSStyleDeclaration, dark: boolean): ITheme {
  const ansi = dark ? ANSI_DARK : ANSI_LIGHT;
  return {
    background: token(styles, "--background", dark ? "#0b0b0c" : "#f7f8fa"),
    foreground: token(styles, "--foreground", dark ? "#f5f5f7" : "#111827"),
    cursor: token(styles, "--primary", dark ? "#ff7a2e" : "#f97316"),
    cursorAccent: token(styles, "--background", dark ? "#0b0b0c" : "#f7f8fa"),
    selectionBackground: token(styles, "--muted-foreground", dark ? "#6b7280" : "#9ca3af"),
    black: ansi[0],
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: ansi[8],
    brightRed: ansi[9],
    brightGreen: ansi[10],
    brightYellow: ansi[11],
    brightBlue: ansi[12],
    brightMagenta: ansi[13],
    brightCyan: ansi[14],
    brightWhite: ansi[15],
  };
}
