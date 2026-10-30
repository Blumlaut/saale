"use client";

import { useTheme } from "next-themes";
import { colorModeOf, type ColorMode } from "@/lib/theme";

/** The palette the page is painted in, for renderers that read no CSS tokens. */
export function useColorMode(): ColorMode {
  const { resolvedTheme } = useTheme();
  return colorModeOf(resolvedTheme);
}
