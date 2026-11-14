import { prisma } from "@/lib/db";
import { renderImage, type RenderedImage } from "@/lib/image-render";
import { resolveImageCapabilities } from "@/lib/pi/image-model";
import { saveAssistantMessage } from "@/lib/pi/stream-helpers";
import { normalizeImageSizes, pickImageSize } from "@/lib/providers/images/sizes";
import type { CommandHandler, CommandOutcome } from "../types";

/** `1024x1024 a red fox`, the size being optional. */
const SIZE_ARGUMENT = /^(\d{1,5}x\d{1,5})\s+([\s\S]+)$/;

/**
 * `/image`. render a picture from a prompt.
 *
 * The agent's `generate_image` tool does the same render, so this is the way to
 * get one without a model turn: no provider request, no tokens, no thinking
 * time. The picture lands in the transcript as the card the tool produces.
 */
export const imageHandler: CommandHandler = {
  run: async (ctx): Promise<CommandOutcome> => {
    if (!ctx.sessionId) {
      return { message: "This message doesn't belong to a chat yet.", tone: "info" };
    }

    const { size, prompt } = parseArguments(ctx.args);
    if (!prompt) {
      return {
        message: "Describe the picture: /image a red fox in the snow",
        tone: "error",
      };
    }

    const capabilities = await resolveImageCapabilities(ctx.userId);
    if (!capabilities.generate) {
      return {
        message: "No image model is configured. Pick one under Settings → Models.",
        tone: "error",
      };
    }

    const sizes = normalizeImageSizes(capabilities.sizes);
    if (size && !sizes.includes(size)) {
      return {
        message: `This model renders at ${sizes.join(", ")}.`,
        tone: "error",
      };
    }

    const { image, sentence } = await renderImage({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      prompt,
      size: pickImageSize(sizes, size),
      verb: "Rendered",
    });

    await saveRenderedMessage(ctx.sessionId, prompt, image, sentence);
    return { message: sentence, tone: "success", refresh: "messages" };
  },
};

/** The size a user typed in front of the prompt, and the prompt itself. */
function parseArguments(args: string): { size?: string; prompt: string } {
  const match = SIZE_ARGUMENT.exec(args.trim());
  if (!match) return { prompt: args.trim() };
  return { size: match[1]!.toLowerCase(), prompt: match[2]!.trim() };
}

/**
 * Write the render into the conversation.
 *
 * The row carries the same `generate_image` call the tool would have made, so
 * the transcript draws it with the card it already knows and a reload puts it
 * back.
 */
async function saveRenderedMessage(
  sessionId: string,
  prompt: string,
  image: RenderedImage,
  sentence: string,
): Promise<void> {
  const result = `${sentence}\n${JSON.stringify({ _saaleImageMeta: image })}`;

  await saveAssistantMessage({
    sessionId,
    content: "",
    toolCalls: [
      {
        id: crypto.randomUUID(),
        name: "generate_image",
        args: { prompt, size: `${image.width}x${image.height}` },
        result,
        isError: false,
      },
    ],
  });

  // A rendered picture is new content, so the chat moves up in the session list.
  await prisma.chatSession
    .update({ where: { id: sessionId }, data: { lastActivityAt: new Date() } })
    .catch((err) => {
      console.error(`Failed to bump lastActivityAt after a render in ${sessionId}:`, err);
    });
}
