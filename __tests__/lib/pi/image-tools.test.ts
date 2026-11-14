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

/** The runtime the tools call, with one image model behind it. */
function stubImageModel(
  result: Record<string, unknown>,
  input: ("text" | "image")[] = ["text", "image"],
) {
  const generateImages = vi.fn().mockResolvedValue(result);
  hoisted.loadImageModel.mockResolvedValue({
    runtime: { generateImages },
    model: {
      type: "image",
      id: "flux",
      name: "Flux",
      provider: "openrouter",
      input,
    },
    pick: { provider: "openrouter", id: "flux" },
  });
  return generateImages;
}

/** The tools an account with a model that edits gets. */
function tools() {
  return createImageTools("user-1", "session-1", { edit: true, sizes: ["1024x1024"] });
}

/** Run one named tool the way Pi does, and read the result it produces. */
async function run(name: string, params: Record<string, unknown>) {
  const tool = tools().find((candidate) => candidate.name === name)!;
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

/** A result that rendered one picture. */
const RENDERED = {
  stopReason: "stop",
  output: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
};

describe("image tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.storeGeneratedImage.mockResolvedValue({
      storageId: "img-1",
      storagePath: "generated/img-1.png",
      width: 1024,
      height: 768,
    });
  });

  it("offers the edit tool only to a model that takes a picture", () => {
    expect(tools().map((tool) => tool.name)).toEqual(["generate_image", "edit_image"]);
    expect(
      createImageTools("user-1", "session-1", { edit: false, sizes: ["1024x1024"] }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["generate_image"]);
  });

  it("renders a prompt, saves the picture and reports where it went", async () => {
    const generateImages = stubImageModel(RENDERED);

    const text = textOf(await run("generate_image", { prompt: "A red fox in the snow" }));

    expect(generateImages).toHaveBeenCalledWith(
      expect.objectContaining({ id: "flux" }),
      { input: [{ type: "text", text: "A red fox in the snow" }] },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hoisted.storeGeneratedImage).toHaveBeenCalledWith(
      "user-1",
      Buffer.from("aW1n", "base64"),
    );
    expect(text).toContain("generated/img-1.png");
    expect(text).toContain('"_saaleImageMeta"');
    expect(text).toContain('"width":1024');
  });

  it("renders at the account's default size unless the agent picks another", async () => {
    const generateImages = stubImageModel(RENDERED);
    const sized = createImageTools("user-1", "session-1", {
      edit: true,
      sizes: ["2048x2048", "1024x1024"],
    });
    const execute = sized.find((tool) => tool.name === "generate_image")!.execute as unknown as (
      id: string,
      params: unknown,
    ) => Promise<unknown>;

    await execute("call-1", { prompt: "a fox" });
    await execute("call-2", { prompt: "a fox", size: "1024x1024" });
    await execute("call-3", { prompt: "a fox", size: "512x512" });

    const sizes = generateImages.mock.calls.map(
      (call) => (call[2] as { metadata?: { size?: string } }).metadata?.size,
    );
    // The first size is the default, and a size outside the list is not sent.
    expect(sizes).toEqual(["2048x2048", "1024x1024", "2048x2048"]);
  });

  it("edits a workspace picture and keeps the original", async () => {
    const generateImages = stubImageModel(RENDERED);
    hoisted.readWorkspaceFile.mockResolvedValue({
      fileName: "fox.png",
      mimeType: "image/png",
      size: 3,
      buffer: Buffer.from("ref"),
    });

    const text = textOf(
      await run("edit_image", { images: ["generated/fox.png"], prompt: "make it snow" }),
    );

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
    // The edited version is a new file; the picture it came from is untouched.
    expect(hoisted.storeGeneratedImage).toHaveBeenCalledTimes(1);
    expect(text).toContain("Edited");
  });

  it("refuses to edit with a model that renders from a prompt alone", async () => {
    const [generate] = [stubImageModel(RENDERED, ["text"])];
    hoisted.readWorkspaceFile.mockResolvedValue({
      fileName: "fox.png",
      mimeType: "image/png",
      size: 3,
      buffer: Buffer.from("ref"),
    });

    await expect(
      run("edit_image", { images: ["generated/fox.png"], prompt: "make it snow" }),
    ).rejects.toThrow("cannot edit a picture");
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses a reference that is not a picture", async () => {
    stubImageModel(RENDERED);
    hoisted.readWorkspaceFile.mockResolvedValue({
      fileName: "notes.txt",
      mimeType: "text/plain",
      size: 3,
      buffer: Buffer.from("hi"),
    });

    await expect(run("edit_image", { images: ["notes.txt"], prompt: "x" })).rejects.toThrow(
      "is not an image",
    );
  });

  // Combining two pictures is the reason the tool takes a list: the model reads
  // them in order, so the list reaches the endpoint as it was given.
  it("sends every picture of a combined edit, in order", async () => {
    const generateImages = stubImageModel(RENDERED);
    hoisted.readWorkspaceFile.mockImplementation(async (_userId: string, path: string) => ({
      fileName: path.split("/").pop(),
      mimeType: "image/png",
      size: 3,
      buffer: Buffer.from(path),
    }));

    await run("edit_image", {
      images: ["generated/room.png", "generated/person.png"],
      prompt: "put the person from the second picture in the room from the first",
    });

    expect(generateImages.mock.calls[0]![1]).toEqual({
      input: [
        { type: "text", text: "put the person from the second picture in the room from the first" },
        {
          type: "image",
          data: Buffer.from("generated/room.png").toString("base64"),
          mimeType: "image/png",
        },
        {
          type: "image",
          data: Buffer.from("generated/person.png").toString("base64"),
          mimeType: "image/png",
        },
      ],
    });
  });

  it("offers at most four pictures and needs one", () => {
    const edit = tools().find((tool) => tool.name === "edit_image")!;
    const schema = edit.parameters as unknown as {
      properties: { images: { minItems: number; maxItems: number } };
    };

    expect(schema.properties.images.minItems).toBe(1);
    expect(schema.properties.images.maxItems).toBe(4);
  });

  // A provider that reports no price leaves the turn's cost at zero rather than
  // a guessed one; the metadata only carries a cost when it is real.
  it("leaves the cost out when the provider bills nothing", async () => {
    stubImageModel(RENDERED);

    const text = textOf(await run("generate_image", { prompt: "a fox" }));

    expect(text).not.toContain('"cost"');
    expect(imageRenderCost([{ result: text }])).toBe(0);
  });

  it("adds the render's price to what the turn cost", async () => {
    stubImageModel({
      ...RENDERED,
      usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.04 } },
    });

    const text = textOf(await run("generate_image", { prompt: "a fox" }));

    expect(imageRenderCost([{ result: text }])).toBeCloseTo(0.04);
  });

  it("fails the call with the model's own reason", async () => {
    stubImageModel({ stopReason: "error", errorMessage: "no recipe selected", output: [] });

    await expect(run("generate_image", { prompt: "a fox" })).rejects.toThrow("no recipe selected");
    expect(hoisted.storeGeneratedImage).not.toHaveBeenCalled();
  });

  it("refuses to render with no image model configured", async () => {
    hoisted.loadImageModel.mockResolvedValue(null);

    await expect(run("generate_image", { prompt: "a fox" })).rejects.toThrow(
      "No image model is configured",
    );
  });
});
