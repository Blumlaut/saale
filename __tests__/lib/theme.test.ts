import { describe, it, expect } from "vitest";
import { colorModeOf, COLOR_MODES, DEFAULT_THEME, THEME_NAMES } from "@/lib/theme";

describe("theme modes", () => {
  it("resolves every offered scheme to a palette", () => {
    for (const name of THEME_NAMES) {
      expect(COLOR_MODES).toContain(colorModeOf(name));
    }
  });

  it("paints a scheme it does not know light", () => {
    // next-themes hands over whatever the stored preference says, including a
    // scheme this build has dropped.
    expect(colorModeOf("solarized")).toBe("light");
    expect(colorModeOf(undefined)).toBe("light");
  });

  it("defaults to a scheme it offers", () => {
    expect(THEME_NAMES).toContain(DEFAULT_THEME);
  });
});
