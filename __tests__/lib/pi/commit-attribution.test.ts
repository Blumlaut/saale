import { describe, it, expect } from "vitest";
import {
  commitAttributionLine,
  resolveAttributionLine,
  DEFAULT_ATTRIBUTION_LINE,
} from "@/lib/pi/commit-attribution";

/**
 * The line an instance puts on its coder commits. Off, a chat is told nothing.
 * On, the admin's words are passed through untouched, and Saale fills the
 * `SAALE_*` variables in itself: the prompt carries finished text, so a commit
 * written through a quoted heredoc still names the model.
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

describe("resolveAttributionLine", () => {
  const values = {
    SAALE_MODEL: "deepseek-v4.1-flash",
    SAALE_MODEL_PROVIDER: "openrouter",
  };

  it("fills every variable that has a value", () => {
    expect(
      resolveAttributionLine(
        "Co-Authored-By: Saale ($SAALE_MODEL via $SAALE_MODEL_PROVIDER)",
        values,
      ),
    ).toBe("Co-Authored-By: Saale (deepseek-v4.1-flash via openrouter)");
  });

  it("leaves a variable with no value as the admin wrote it", () => {
    expect(resolveAttributionLine("Co-Authored-By: Saale ($SAALE_MODEL)", {})).toBe(
      "Co-Authored-By: Saale ($SAALE_MODEL)",
    );
  });

  it("leaves a name it does not own alone", () => {
    expect(resolveAttributionLine("Co-Authored-By: Saale ($HOME)", values)).toBe(
      "Co-Authored-By: Saale ($HOME)",
    );
  });

  it("turns the default line into the model it names", () => {
    const line = commitAttributionLine({ enabled: true, text: "" }) ?? "";
    const resolved = resolveAttributionLine(line, values);
    expect(resolved).toContain("deepseek-v4.1-flash");
    expect(resolved).not.toContain("$");
  });
});
