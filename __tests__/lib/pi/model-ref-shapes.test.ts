import { describe, expect, it } from "vitest";

import { formatModelId, toPickerModelId, toStoredModelId } from "@/lib/pi/model-ref";

describe("model reference shapes", () => {
  it("moves a reference between the picker and stored forms", () => {
    expect(toStoredModelId("openai/gpt-4o")).toBe("openai:gpt-4o");
    expect(toPickerModelId("openai:gpt-4o")).toBe("openai/gpt-4o");
  });

  it("only rewrites the provider separator", () => {
    const stored = toStoredModelId("openrouter/anthropic/claude-sonnet-4");
    expect(stored).toBe("openrouter:anthropic/claude-sonnet-4");
    expect(toPickerModelId(stored)).toBe("openrouter/anthropic/claude-sonnet-4");
  });

  it("writes a reference as model then provider", () => {
    expect(formatModelId("openai:gpt-4o")).toBe("gpt-4o (openai)");
    expect(formatModelId("openrouter:anthropic/claude-sonnet-4")).toBe(
      "anthropic/claude-sonnet-4 (openrouter)",
    );
  });

  it("leaves a bare id and an empty one alone", () => {
    expect(formatModelId("gpt-4o")).toBe("gpt-4o");
    expect(formatModelId(null)).toBeNull();
    expect(formatModelId("  ")).toBeNull();
  });
});
