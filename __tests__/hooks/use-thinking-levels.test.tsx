// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useModelThinkingLevels } from "@/hooks/use-thinking-levels";

/**
 * The selectors filter their level list by what Pi says the model supports, so
 * "not known yet" must not read as "this model supports nothing", and a level
 * the model lacks must report Pi's own clamp rather than a guess.
 */

function levelsResponse(levels: string[], reasoning = true) {
  return { ok: true, status: 200, json: async () => ({ levels, reasoning }) };
}

describe("useModelThinkingLevels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks Pi for the model's levels", async () => {
    const fetchMock = vi.fn().mockResolvedValue(levelsResponse(["low", "high", "max"]));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useModelThinkingLevels("anthropic", "claude", "high"));

    await waitFor(() => expect(result.current.levels).toEqual(["low", "high", "max"]));
    expect(fetchMock.mock.calls[0]![0]).toContain("provider=anthropic&model=claude");
    expect(result.current.reasoning).toBe(true);
    expect(result.current.unsupported).toBe(false);
  });

  it("leaves the levels unknown when the lookup fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const { result } = renderHook(() => useModelThinkingLevels("anthropic", "claude", "high"));

    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(result.current.levels).toBeNull();
    expect(result.current.unsupported).toBe(false);
  });

  it("treats 'default' as supported whatever the model offers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(levelsResponse(["low", "high"])));

    const { result } = renderHook(() => useModelThinkingLevels("anthropic", "claude", "default"));

    await waitFor(() => expect(result.current.levels).toEqual(["low", "high"]));
    expect(result.current.unsupported).toBe(false);
    expect(result.current.clampedLevel).toBeNull();
  });

  it("reports where Pi clamps a level the model lacks", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.includes("level=")
          ? { ok: true, status: 200, json: async () => ({ clampedLevel: "max" }) }
          : levelsResponse(["low", "max"]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useModelThinkingLevels("anthropic", "claude", "medium"));

    await waitFor(() => expect(result.current.clampedLevel).toBe("max"));
    expect(result.current.unsupported).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("level=medium"))).toBe(true);
  });
});
