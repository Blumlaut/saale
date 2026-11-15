import { MAX_REFERENCES } from "@/lib/image-render";
import type { CommandHandler, CommandOutcome } from "../types";
import { imageModelFor, renderSize, renderWithCard, sizeOptions } from "./image-shared";

/**
 * `/edit prompt:make it night`, with the pictures attached in the composer.
 *
 * The same render as the agent's `edit_image` tool, reached without a model
 * turn: attach one picture to change it, several to combine them, and the card
 * the tool would have drawn shows the result. The order the composer lists the
 * files in is the order the endpoint sees them.
 */
export const editHandler: CommandHandler = {
  options: async (ctx) => ({ size: await sizeOptions(ctx.userId, "edit") }),

  run: async (ctx): Promise<CommandOutcome> => {
    if (!ctx.sessionId) {
      return { message: "This message doesn't belong to a chat yet.", tone: "info" };
    }

    const references = ctx.files.filter((file) => file.mimeType.startsWith("image/"));
    if (references.length === 0) {
      return {
        message: "Attach the picture with the paperclip, then: /edit prompt:make it night",
        tone: "error",
      };
    }
    if (references.length > MAX_REFERENCES) {
      return {
        message: `Attach at most ${MAX_REFERENCES} pictures to combine.`,
        tone: "error",
      };
    }

    const prompt = ctx.arguments.prompt ?? "";
    const model = await imageModelFor(ctx.userId, "edit");
    if (!model.ok) return { message: model.message, tone: "error" };

    const chosen = renderSize(model.sizes, ctx.arguments.size?.toLowerCase());
    if ("error" in chosen) return { message: chosen.error, tone: "error" };

    const paths = references.map((file) => file.path);
    const { sentence } = await renderWithCard({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      prompt,
      references: paths,
      size: chosen.size,
      verb: "Edited",
      toolName: "edit_image",
      args: { prompt, images: paths, size: chosen.size },
    });

    // The card is the result, so nothing is toasted over it.
    return { message: sentence, tone: "success", refresh: "messages", quiet: true };
  },
};
