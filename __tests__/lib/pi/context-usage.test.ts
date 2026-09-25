import { describe, it, expect } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readContextUsage } from "@/lib/pi/context-usage";

/** Minimal session stand-in: only the fields readContextUsage touches. */
function session(overrides: {
  contextUsage?:
    { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  model?: { contextWindow?: number } | undefined;
}): AgentSession {
  return {
    getContextUsage: () => overrides.contextUsage,
    model: overrides.model,
  } as unknown as AgentSession;
}

describe("readContextUsage", () => {
  it("reports Pi's context size", () => {
    expect(
      readContextUsage(
        session({ contextUsage: { tokens: 42_000, contextWindow: 128_000, percent: 32.8 } }),
      ),
    ).toEqual({ tokens: 42_000, contextWindow: 128_000 });
  });

  it("keeps the window when the token count is unknown", () => {
    // Right after a compaction Pi knows the window but not the fill yet.
    expect(
      readContextUsage(
        session({ contextUsage: { tokens: null, contextWindow: 128_000, percent: null } }),
      ),
    ).toEqual({ tokens: null, contextWindow: 128_000 });
  });

  it("falls back to the model's window when Pi reports nothing", () => {
    // Undefined when no model is selected or the window is non-positive.
    expect(readContextUsage(session({ contextUsage: undefined, model: {} }))).toEqual({
      tokens: null,
      contextWindow: 0,
    });
    expect(
      readContextUsage(session({ contextUsage: undefined, model: { contextWindow: 200_000 } })),
    ).toEqual({ tokens: null, contextWindow: 200_000 });
  });
});
