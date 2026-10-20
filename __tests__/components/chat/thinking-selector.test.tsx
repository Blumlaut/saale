// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";

// The popover is irrelevant to the level filtering — render its parts inline so
// the options are always in the DOM.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { ThinkingSelector } from "@/components/chat/thinking-selector";

/**
 * The selector filters the level list down to what the model supports. That
 * list arrives asynchronously, and "not known yet" must not be treated as "this
 * model supports nothing" — that left only "Default" selectable while the
 * request was in flight, and permanently so when it failed.
 */

function optionLabels(): string[] {
  return screen.getAllByRole("button").map((b) => b.textContent ?? "");
}

describe("ThinkingSelector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderSelector(value = "high") {
    render(
      <ThinkingSelector
        value={value}
        onChange={() => {}}
        modelProvider="custom"
        modelName="llama"
      />,
    );
  }

  it("keeps every level selectable when the model's levels cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderSelector();
    await waitFor(() => expect(errorSpy).toHaveBeenCalled());

    const labels = optionLabels();
    expect(labels.some((l) => l.includes("High"))).toBe(true);
    expect(labels.length).toBeGreaterThan(1);
  });

  it("keeps every level selectable when the lookup returns an error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }),
    );

    renderSelector();
    // No levels were learned, so nothing may be hidden.
    await waitFor(() => expect(optionLabels().length).toBeGreaterThan(1));
    expect(optionLabels().some((l) => l.includes("High"))).toBe(true);
  });

  it("offers only the model's levels (plus Default) when the lookup succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ levels: ["off"] }) }),
    );

    renderSelector("off");

    await waitFor(() => {
      const labels = optionLabels();
      expect(labels.some((l) => l.includes("Off"))).toBe(true);
      expect(labels.some((l) => l.includes("High"))).toBe(false);
      // "default" means "don't override Pi" and is never a model capability.
      expect(labels.some((l) => l.includes("Default"))).toBe(true);
    });
  });

  it("never warns that Default is unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ levels: ["low", "high", "max"] }),
      }),
    );

    renderSelector("default");

    await waitFor(() => expect(optionLabels().length).toBe(4));
    expect(screen.queryByText(/not supported/)).toBeNull();
  });

  it("warns when a level the model lacks is selected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.includes("level=")
            ? { clampedLevel: "high" }
            : { levels: ["low", "high", "max"], reasoning: true },
      })),
    );

    renderSelector("medium");

    await waitFor(() =>
      expect(
        screen.getByText(/"medium" is not supported by this model and will be clamped to "high"/),
      ).toBeInTheDocument(),
    );
  });
});
