import { describe, it, expect } from "vitest";
import { commitAttributionLine, DEFAULT_ATTRIBUTION_LINE } from "@/lib/pi/commit-attribution";

/**
 * The line an instance puts on its coder commits. Off, a chat is told nothing.
 * On, the admin's words are passed through untouched: the `SAALE_*` variables
 * in them are the shell's to expand when the commit is made.
 */

describe("commitAttributionLine", () => {
  it("is nothing while the trailer switch is off", () => {
    expect(commitAttributionLine({ enabled: false, text: "Attributed-to: Saale" })).toBe(null);
    // A row no admin has written yet carries neither field.
    expect(commitAttributionLine({})).toBe(null);
  });

  it("passes the admin's line through for the shell to expand", () => {
    expect(
      commitAttributionLine({
        enabled: true,
        text: "Co-Authored-By: Saale ($SAALE_MODEL via $SAALE_MODEL_PROVIDER)",
      }),
    ).toBe("Co-Authored-By: Saale ($SAALE_MODEL via $SAALE_MODEL_PROVIDER)");
  });

  it("names the model when the admin wrote no line", () => {
    expect(commitAttributionLine({ enabled: true, text: "  " })).toBe(DEFAULT_ATTRIBUTION_LINE);
    expect(commitAttributionLine({ enabled: true })).toBe(DEFAULT_ATTRIBUTION_LINE);
    expect(DEFAULT_ATTRIBUTION_LINE).toContain("$SAALE_MODEL");
  });

  it("trims the line the admin pasted in", () => {
    expect(commitAttributionLine({ enabled: true, text: "  Co-Authored-By: Saale  " })).toBe(
      "Co-Authored-By: Saale",
    );
  });
});
