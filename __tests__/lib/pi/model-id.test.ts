import { describe, expect, it } from "vitest";

import { formatModelId, toPickerModelId, toStoredModelId } from "@/lib/pi/model-id";

describe("model ids", () => {
  it("moves an id from the picker shape to the stored shape and back", () => {
    expect(toStoredModelId("openai/gpt-4o")).toBe("openai:gpt-4o");
    expect(toPickerModelId("openai:gpt-4o")).toBe("openai/gpt-4o");
  });

  it("keeps slashes inside a model name when it round trips", () => {
    const stored = toStoredModelId("ollama/library/llama3");
    expect(stored).toBe("ollama:library/llama3");
    expect(toPickerModelId(stored)).toBe("ollama/library/llama3");
  });

  it("leaves an id without a separator alone", () => {
    expect(toStoredModelId("gpt-4o")).toBe("gpt-4o");
    expect(toPickerModelId("gpt-4o")).toBe("gpt-4o");
  });

  it("writes a stored id as model then provider", () => {
    expect(formatModelId("openai:gpt-4o")).toBe("gpt-4o (openai)");
    expect(formatModelId("nano-gpt:vendor/model")).toBe("vendor/model (nano-gpt)");
    expect(formatModelId("gpt-4o")).toBe("gpt-4o");
    expect(formatModelId(null)).toBeNull();
  });
});
