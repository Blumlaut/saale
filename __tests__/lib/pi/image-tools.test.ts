import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  loadImageModel: vi.fn(),
  storeGeneratedImage: vi.fn(),
  readWorkspaceFile: vi.fn(),
}));

vi.mock("@/lib/pi/image-model", () => ({ loadImageModel: hoisted.loadImageModel }));
vi.mock("@/lib/image-attachment", () => ({
  storeGeneratedImage: hoisted.storeGeneratedImage,
}));
vi.mock("@/lib/files/workspace-file", () => ({ readWorkspaceFile: hoisted.readWorkspaceFile }));

import { createImageTools } from "@/lib/pi/tools/image-tools";
import { imageRenderCost } from "@/lib/pi/turn-stats";

/** The runtime the tool calls, with one image model behind it. */
function stubImageModel(result: Record<string, unknown>) {
  const generateImages = vi.fn().mockResolvedValue(result);
  hoisted.loadImageModel.mockResolvedValue({
    runtime: { generateImages },
    model: { type: "image", id: "flux", name: "Flux", provider: "openrouter" },
    pick: { provider: "openrouter", id: "flux" },
  });
  return generateImages;
}

/** Run the tool the way Pi does, and read the result it produces. */
async function run(params: { prompt: string; image?: string }) {
  const tool = createImageTools("user-1", "session-1");
  const execute = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;

  return execute("call-1", params, new AbortController().signal);
}

/** The text of a result, which carries the value and the metadata block. */
function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((block) => block.text).join("");
}

describe("generate_image", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.storeGeneratedImage.mockResolvedValue({
      storageId: "img-1",
      storagePath: "generated/img-1.png",
      width: 1024,
      height: 768,
    });
  });

  it("renders a prompt, saves the picture and reports where it went", async () => {
    const generateImages = stubImageModel({
      stopReason: "stop",
      output: [
        { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
      ],
    });

    const result = await run({ prompt: "A red fox in the snow" });
    const text = textOf(result);

    expect(generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "flux" }),
      { input: [{ type: "text", text: "A red fox in the snow" }] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hoisted.storeGeneratedImage).toHaveBeenCalledWith("user-1", Buffer.from("png-bytes"));
    expect(text).toContain("generated/img-1.png");
    expect(text).toContain('"_saaleImageMeta"');
    expect(text).toContain('"width":1024');
  });

  // A provider that reports no price leaves the turn's cost at zero rather than
  // a guessed one; the metadata only carries a cost when it is real.
  it("leaves the cost out when the provider bills nothing", async () => {
    stubImageModel({
      stopReason: "stop",
      output: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
    });

    const text = textOf(await run({ prompt: "a fox" }));

    expect(text).not.toContain('"cost"');
    expect(imageRenderCost([{ result: text }])).toBe(0);
  });

  it("adds the render's price to what the turn cost", async () => {
    stubImageModel({
      stopReason: "stop",
      output: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
      usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.04 } },
    });

    const text = textOf(await run({ prompt: "a fox" }));

    expect(imageRenderCost([{ result: text }])).toBeCloseTo(0.04);
  });

  it("sends a workspace picture as the image to edit", async () => {
    const generateImages = stubImageModel({
      stopReason: "stop",
      output: [{ type: "image", data: "ZWRpdA==", mimeType: "image/png" }],
    });
    hoisted.readWorkspaceFile.mockResolvedValue({
      fileName: "fox.png",
      mimeType: "image/png",
      size: 3,
      buffer: Buffer.from("ref"),
    });

    await run({ prompt: "make it snow", image: "generated/fox.png" });

    expect(generateImages).toHaveBeenCalledWith(
      expect.anything(),
      {
        input: [
          { type: "text", text: "make it snow" },
          { type: "image", data: Buffer.from("ref").toString("base64"), mimeType: "image/png" },
        ],
      },
      expect.anything(),
    );
  });

  it("fails the call with the model's own reason", async () => {
    stubImageModel({ stopReason: "error", errorMessage: "no recipe selected", output: [] });

    await expect(run({ prompt: "a fox" })).rejects.toThrow("no recipe selected");
    expect(hoisted.storeGeneratedImage).not.toHaveBeenCalled();
  });

  it("refuses to render with no image model configured", async () => {
    hoisted.loadImageModel.mockResolvedValue(null);

    await expect(run({ prompt: "a fox" })).rejects.toThrow("No image model is configured");
  });
});
