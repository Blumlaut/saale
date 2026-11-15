import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  renderImage: vi.fn(),
  appendRenderNote: vi.fn(),
  resolveImageCapabilities: vi.fn(),
  saveAssistantMessage: vi.fn(),
  publishSessionEvent: vi.fn(),
  bumpSession: vi.fn(),
}));

vi.mock("@/lib/image-render", () => ({ renderImage: hoisted.renderImage }));
vi.mock("@/lib/pi/image-model", () => ({
  resolveImageCapabilities: hoisted.resolveImageCapabilities,
}));
vi.mock("@/lib/pi/stream-helpers", () => ({
  saveAssistantMessage: hoisted.saveAssistantMessage,
}));
vi.mock("@/lib/pi/session-events", () => ({
  publishSessionEvent: hoisted.publishSessionEvent,
}));
vi.mock("@/lib/pi/render-notes", () => ({
  appendRenderNote: hoisted.appendRenderNote,
}));
vi.mock("@/lib/db", () => ({
  prisma: { chatSession: { update: (...args: unknown[]) => hoisted.bumpSession(...args) } },
}));

import { imageHandler } from "@/lib/commands/handlers/image";
import { webContext } from "../../../helpers/command-context";

const ctx = (args: string) => webContext("image", args);

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

interface SavedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status?: string;
  isError?: boolean;
}

/** The writes the handler made into the chat, in order. */
function savedMessages() {
  return hoisted.saveAssistantMessage.mock.calls.map(
    (call) => call[0] as { sessionId: string; messageId?: string; toolCalls: SavedCall[] },
  );
}

/** The card's final state: the sentence, then the metadata the card reads. */
function finishedCard() {
  const writes = savedMessages();
  const call = writes.at(-1)!.toolCalls[0]!;
  const [sentence, meta] = call.result!.split("\n");
  return { writes, call, sentence, meta: JSON.parse(meta!) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.bumpSession.mockResolvedValue({});
  hoisted.publishSessionEvent.mockResolvedValue(1);
  hoisted.saveAssistantMessage.mockResolvedValue({ id: "message-1" });
  hoisted.appendRenderNote.mockResolvedValue(undefined);
});

describe("/image", () => {
  it("renders the prompt and puts the picture in the conversation", async () => {
    availableModel();
    renders();

    const outcome = await imageHandler.run(ctx("a red fox in the snow"));

    expect(outcome).toMatchObject({ tone: "success", refresh: "messages" });
    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a red fox in the snow", size: "1024x1024" }),
    );

    const { call, meta } = finishedCard();
    // The card reads the render out of the tool call, so it has to look like one.
    expect(call.name).toBe("generate_image");
    expect(meta).toEqual({
      _saaleImageMeta: expect.objectContaining({ path: "generated/9b1c.webp", width: 1024 }),
    });
    expect(hoisted.bumpSession).toHaveBeenCalled();
  });

  // The agent reads its own transcript, so a render made without a model turn
  // has to be noted there or the next message knows nothing about it.
  it("notes the render in the chat's transcript for the next turn", async () => {
    availableModel();
    renders();

    await imageHandler.run(ctx("a red fox in the snow"));

    expect(hoisted.appendRenderNote).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: "session-1",
      command: "image",
      sentence: 'Rendered "a red fox in the snow" with Flux (1024×768).',
    });
  });

  it("shows the call as running before it renders, then fills in the picture", async () => {
    availableModel();
    renders();

    await imageHandler.run(ctx("a red fox in the snow"));

    const [start, finish] = savedMessages();
    expect(start!.toolCalls[0]).toMatchObject({
      name: "generate_image",
      status: "running",
      result: undefined,
      args: { prompt: "a red fox in the snow" },
    });
    expect(finish!.messageId).toBe("message-1");
    expect(finish!.toolCalls[0]!.status).toBeUndefined();
    expect(finish!.toolCalls[0]!.result).toContain("_saaleImageMeta");
    // The row exists before the endpoint is called, so it needs no second row.
    expect(hoisted.saveAssistantMessage).toHaveBeenCalledTimes(2);
  });

  it("tells every client watching the chat to reload, before and after", async () => {
    availableModel();
    renders();

    await imageHandler.run(ctx("a red fox in the snow"));

    expect(hoisted.publishSessionEvent).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "messages_changed",
      {},
    );
    expect(hoisted.publishSessionEvent).toHaveBeenCalledTimes(2);
  });

  it("renders at the size the user asked for", async () => {
    availableModel();
    renders();

    await imageHandler.run(ctx("1536x1024 a red fox in the snow"));

    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a red fox in the snow", size: "1536x1024" }),
    );
  });

  it("reads the named form of the prompt and size", async () => {
    availableModel();
    renders();

    await imageHandler.run(ctx("prompt:a red fox in the snow size:1536x1024"));

    expect(hoisted.renderImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a red fox in the snow", size: "1536x1024" }),
    );
    // The card is asked for the size the picture is rendered at.
    expect(finishedCard().call.args).toMatchObject({ size: "1536x1024" });
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

  it("lists the resolutions the model renders at, for the composer", async () => {
    availableModel(["1024x1024", "1024x1536"]);

    const options = await imageHandler.options!(ctx(""));

    expect(options.size).toEqual([
      { value: "1024x1024", label: "square", description: "The model's default" },
      { value: "1024x1536", label: "portrait" },
    ]);
  });

  it("offers no resolution when the account has no image model", async () => {
    hoisted.resolveImageCapabilities.mockResolvedValue({
      generate: false,
      edit: false,
      sizes: ["1024x1024"],
    });

    expect(await imageHandler.options!(ctx(""))).toEqual({ size: [] });
  });

  it("marks the card failed when the endpoint does", async () => {
    availableModel();
    hoisted.renderImage.mockRejectedValue(new Error("The image model returned no image."));

    await expect(imageHandler.run(ctx("a red fox"))).rejects.toThrow("returned no image");

    const writes = savedMessages();
    expect(writes.at(-1)!.messageId).toBe("message-1");
    expect(writes.at(-1)!.toolCalls[0]).toMatchObject({ isError: true });
    expect(hoisted.publishSessionEvent).toHaveBeenCalledTimes(2);
  });
});
