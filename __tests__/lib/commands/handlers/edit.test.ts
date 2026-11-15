import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  renderImage: vi.fn(),
  resolveImageCapabilities: vi.fn(),
  saveAssistantMessage: vi.fn(),
  bumpSession: vi.fn(),
}));

vi.mock("@/lib/image-render", () => ({
  renderImage: hoisted.renderImage,
  MAX_REFERENCES: 4,
}));
vi.mock("@/lib/pi/image-model", () => ({
  resolveImageCapabilities: hoisted.resolveImageCapabilities,
}));
vi.mock("@/lib/pi/stream-helpers", () => ({
  saveAssistantMessage: hoisted.saveAssistantMessage,
}));
vi.mock("@/lib/db", () => ({
  prisma: { chatSession: { update: (...args: unknown[]) => hoisted.bumpSession(...args) } },
}));

import { editHandler } from "@/lib/commands/handlers/edit";
import { commandImage, webContext } from "../../../helpers/command-context";

/** A model that takes a picture to edit, at the sizes the admin gave it. */
function editableModel(overrides: Record<string, unknown> = {}) {
  hoisted.resolveImageCapabilities.mockResolvedValue({
    generate: true,
    edit: true,
    sizes: ["1024x1024", "1536x1024"],
    ...overrides,
  });
}

function renders(prompt = "make it night") {
  hoisted.renderImage.mockResolvedValue({
    image: {
      path: "generated/edited.webp",
      model: "qwen-image-edit",
      provider: "openrouter",
      prompt,
      width: 1024,
      height: 1024,
    },
    sentence: `Edited "make it night" with Qwen (1024×1024).`,
  });
}

/** The call the handler wrote into the chat, as the transcript reads it back. */
function savedCall() {
  const input = hoisted.saveAssistantMessage.mock.calls[0]![0] as {
    toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  };
  const call = input.toolCalls[0]!;
  return { call, meta: JSON.parse(call.result.split("\n")[1]!) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.bumpSession.mockResolvedValue({});
});

describe("/edit", () => {
  it("edits the attached picture and shows the result as the tool's card", async () => {
    editableModel();
    renders();
    const photo = commandImage("photo.png", "/home/user/uploads/photo.png");

    const outcome = await editHandler.run(webContext("edit", "prompt:make it night", [photo]));

    expect(outcome).toMatchObject({ tone: "success", refresh: "messages" });
    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "make it night",
        references: ["/home/user/uploads/photo.png"],
        size: "1024x1024",
        verb: "Edited",
      }),
    );

    const { call, meta } = savedCall();
    expect(call.name).toBe("edit_image");
    expect(call.args).toMatchObject({
      prompt: "make it night",
      images: ["/home/user/uploads/photo.png"],
    });
    expect(meta).toEqual({
      _saaleImageMeta: expect.objectContaining({ path: "generated/edited.webp" }),
    });
  });

  it("combines several pictures in the order they were attached", async () => {
    editableModel();
    renders();

    await editHandler.run(
      webContext("edit", "prompt:put the cat in the garden", [
        commandImage("cat.png", "/home/user/uploads/cat.png"),
        commandImage("garden.png", "/home/user/uploads/garden.png"),
      ]),
    );

    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({
        references: ["/home/user/uploads/cat.png", "/home/user/uploads/garden.png"],
      }),
    );
  });

  it("renders at the size the user asked for", async () => {
    editableModel();
    renders();

    await editHandler.run(
      webContext("edit", "prompt:make it night size:1536x1024", [commandImage()]),
    );

    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ size: "1536x1024" }),
    );
  });

  it("refuses a size the model does not render at", async () => {
    editableModel({ sizes: ["1024x1024"] });

    const outcome = await editHandler.run(
      webContext("edit", "prompt:make it night size:2048x2048", [commandImage()]),
    );

    expect(outcome).toMatchObject({ tone: "error" });
    expect(outcome.message).toContain("1024x1024");
    expect(hoisted.renderImage).not.toHaveBeenCalled();
  });

  it("asks for a picture when none was attached", async () => {
    editableModel();

    const outcome = await editHandler.run(webContext("edit", "prompt:make it night"));

    expect(outcome).toMatchObject({ tone: "error" });
    expect(outcome.message).toContain("/edit");
    expect(hoisted.resolveImageCapabilities).not.toHaveBeenCalled();
  });

  it("ignores an attachment that is not a picture", async () => {
    editableModel();

    const outcome = await editHandler.run(
      webContext("edit", "prompt:make it night", [
        {
          path: "/home/user/uploads/notes.txt",
          fileName: "notes.txt",
          mimeType: "text/plain",
          size: 4,
        },
      ]),
    );

    expect(outcome).toMatchObject({ tone: "error" });
    expect(hoisted.renderImage).not.toHaveBeenCalled();
  });

  it("says which way to change the model when it cannot edit", async () => {
    editableModel({ edit: false });

    const outcome = await editHandler.run(
      webContext("edit", "prompt:make it night", [commandImage()]),
    );

    expect(outcome).toMatchObject({ tone: "error" });
    expect(outcome.message).toContain("render");
    expect(hoisted.renderImage).not.toHaveBeenCalled();
  });

  it("reports what the endpoint said when the edit fails", async () => {
    editableModel();
    hoisted.renderImage.mockRejectedValue(new Error("The image model returned no image."));

    await expect(
      editHandler.run(webContext("edit", "prompt:make it night", [commandImage()])),
    ).rejects.toThrow("returned no image");
    expect(hoisted.saveAssistantMessage).not.toHaveBeenCalled();
  });
});
