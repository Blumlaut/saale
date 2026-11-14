import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  renderImage: vi.fn(),
  resolveImageCapabilities: vi.fn(),
  saveAssistantMessage: vi.fn(),
  bumpSession: vi.fn(),
}));

vi.mock("@/lib/image-render", () => ({ renderImage: hoisted.renderImage }));
vi.mock("@/lib/pi/image-model", () => ({
  resolveImageCapabilities: hoisted.resolveImageCapabilities,
}));
vi.mock("@/lib/pi/stream-helpers", () => ({
  saveAssistantMessage: hoisted.saveAssistantMessage,
}));
vi.mock("@/lib/db", () => ({
  prisma: { chatSession: { update: (...args: unknown[]) => hoisted.bumpSession(...args) } },
}));

import { imageHandler } from "@/lib/commands/handlers/image";
import type { WebCommandContext } from "@/lib/commands/types";

const ctx = (args: string): WebCommandContext => ({
  surface: "web",
  userId: "user-1",
  sessionId: "session-1",
  args,
});

/** A model that renders, at the sizes the admin gave it. */
function availableModel(sizes: string[] = ["1024x1024", "1536x1024"]) {
  hoisted.resolveImageCapabilities.mockResolvedValue({
    generate: true,
    edit: false,
    sizes,
  });
}

/** What the render hands back, along with the sentence the transcript reads. */
function renders(overrides: Record<string, unknown> = {}) {
  hoisted.renderImage.mockResolvedValue({
    image: {
      path: "generated/9b1c.webp",
      model: "flux",
      provider: "openrouter",
      prompt: "a red fox in the snow",
      width: 1024,
      height: 768,
      ...overrides,
    },
    sentence: 'Rendered "a red fox in the snow" with Flux (1024×768).',
  });
}

/** The call the handler wrote into the chat, as the transcript reads it back. */
function savedCall() {
  const input = hoisted.saveAssistantMessage.mock.calls[0]![0] as {
    sessionId: string;
    content: string;
    toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  };
  const call = input.toolCalls[0]!;
  const [sentence, meta] = call.result.split("\n");
  return { input, call, sentence, meta: JSON.parse(meta!) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.bumpSession.mockResolvedValue({});
});

describe("/image", () => {
  it("renders the prompt and puts the picture in the conversation", async () => {
    availableModel();
    renders();

    const outcome = await imageHandler.run(ctx("a red fox in the snow"));

    expect(outcome.tone).toBe("success");
    expect(outcome.refresh).toBe("messages");
    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a red fox in the snow", size: "1024x1024" }),
    );

    const { input, call, meta } = savedCall();
    expect(input.sessionId).toBe("session-1");
    // The card reads the render out of the tool call, so it has to look like one.
    expect(call.name).toBe("generate_image");
    expect(meta).toEqual({
      _saaleImageMeta: expect.objectContaining({ path: "generated/9b1c.webp", width: 1024 }),
    });
    expect(hoisted.bumpSession).toHaveBeenCalled();
  });

  it("renders at the size the user asked for", async () => {
    availableModel();
    renders();

    await imageHandler.run(ctx("1536x1024 a red fox in the snow"));

    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a red fox in the snow", size: "1536x1024" }),
    );
  });

  it("refuses a size the model does not render at", async () => {
    availableModel(["1024x1024"]);

    const outcome = await imageHandler.run(ctx("2048x2048 a red fox"));

    expect(outcome.tone).toBe("error");
    expect(outcome.message).toContain("1024x1024");
    expect(hoisted.renderImage).not.toHaveBeenCalled();
  });

  it("asks for a prompt when the user gave none", async () => {
    availableModel();

    const outcome = await imageHandler.run(ctx("   "));

    expect(outcome.tone).toBe("error");
    expect(outcome.message).toContain("/image");
    expect(hoisted.resolveImageCapabilities).not.toHaveBeenCalled();
  });

  // Without a model there is nothing to render with, and the account has to be
  // told where to pick one rather than watching the command do nothing.
  it("says where to pick a model when the account has none", async () => {
    hoisted.resolveImageCapabilities.mockResolvedValue({
      generate: false,
      edit: false,
      sizes: ["1024x1024"],
    });

    const outcome = await imageHandler.run(ctx("a red fox"));

    expect(outcome.tone).toBe("error");
    expect(outcome.message).toContain("Settings");
    expect(hoisted.renderImage).not.toHaveBeenCalled();
  });

  it("reports what the endpoint said when the render fails", async () => {
    availableModel();
    hoisted.renderImage.mockRejectedValue(new Error("The image model returned no image."));

    await expect(imageHandler.run(ctx("a red fox"))).rejects.toThrow("returned no image");
    expect(hoisted.saveAssistantMessage).not.toHaveBeenCalled();
  });
});
