import type { CommandHandler, CommandOutcome } from "../types";
import { imageModelFor, renderSize, renderWithCard } from "./image-shared";

/** `1024x1024 a red fox`, the positional form the command started as. */
const SIZE_ARGUMENT = /^(\d{1,5}x\d{1,5})\s+([\s\S]+)$/;

/**
 * `/image prompt:a red fox size:1536x1024`. render a picture from a prompt.
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

    const { size, prompt } = readArguments(ctx);
    if (!prompt) {
      return {
        message: "Describe the picture: /image prompt:a red fox in the snow",
        tone: "error",
      };
    }

    const model = await imageModelFor(ctx.userId, "generate");
    if (!model.ok) return { message: model.message, tone: "error" };

    const chosen = renderSize(model.sizes, size);
    if ("error" in chosen) return { message: chosen.error, tone: "error" };

    const { sentence } = await renderWithCard({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      prompt,
      size: chosen.size,
      verb: "Rendered",
      toolName: "generate_image",
      args: { prompt, size: chosen.size },
    });

    // The card is the result, so nothing is toasted over it.
    return { message: sentence, tone: "success", refresh: "messages", quiet: true };
  },
};

/** The prompt and size, from named arguments or the older `size prompt` form. */
function readArguments(ctx: { args: string; arguments: Readonly<Record<string, string>> }): {
  size?: string | undefined;
  prompt: string;
} {
  if (ctx.arguments.prompt) {
    return { size: ctx.arguments.size?.toLowerCase(), prompt: ctx.arguments.prompt };
  }

  const args = ctx.args.trim();
  const match = SIZE_ARGUMENT.exec(args);
  return match ? { size: match[1]!.toLowerCase(), prompt: match[2]!.trim() } : { prompt: args };
}
