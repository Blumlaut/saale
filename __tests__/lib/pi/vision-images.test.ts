import { describe, it, expect } from "vitest";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { configuredVision, resolveModelInput } from "@/lib/providers/capabilities";

/**
 * The contract that decides whether an image ever reaches a model.
 *
 * Pi reads the `input` list of the model definition it was handed, and drops
 * every image block out of a message when that list does not contain `image`
 * (`downgradeUnsupportedImages`, which is also what prints "[Current model does
 * not support images...]"). Saale builds those definitions, so this pins what it
 * writes to what Pi actually does with it — a vision model imported from a
 * self-hosted endpoint must not be told about a picture that was never sent.
 */

const IMAGE_MESSAGE: UserMessage = {
  role: "user",
  content: [
    { type: "text", text: "what is in this image?" },
    { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
  ],
  timestamp: 1,
};

function fakeModel(input: ("text" | "image")[]): Model<"openai-completions"> {
  return {
    id: "Qwen3-VL-8B",
    name: "Qwen3-VL-8B",
    api: "openai-completions",
    provider: "custom",
    baseUrl: "http://localhost:8080/v1",
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

/** The user message Pi would actually send, after its own transformation. */
function sentMessage(input: ("text" | "image")[]): Message {
  return transformMessages([IMAGE_MESSAGE], fakeModel(input))[0]!;
}

describe("Pi's image handling for a Saale-defined model", () => {
  it("keeps the image when the model claims image input", () => {
    const message = sentMessage(resolveModelInput(undefined, true));

    expect(message.content).toContainEqual(
      expect.objectContaining({ type: "image", data: "iVBORw0KGgo=" }),
    );
    expect(JSON.stringify(message.content)).not.toContain("does not support images");
  });

  it("replaces the image with the omission note when it does not", () => {
    const message = sentMessage(resolveModelInput(undefined, false));

    expect(message.content).not.toContainEqual(expect.objectContaining({ type: "image" }));
    expect(JSON.stringify(message.content)).toContain(
      "(image omitted: model does not support images)",
    );
  });

  it("follows a configured capability, not only the catalog", () => {
    // No catalog entry (an id Pi has never heard of), a user-set vision flag.
    const capabilities = { "Qwen3-VL-8B": { vision: true } };
    const input = resolveModelInput(undefined, configuredVision(capabilities, "Qwen3-VL-8B"));

    const message = sentMessage(input);

    expect(message.content).toContainEqual(expect.objectContaining({ type: "image" }));
  });
});
