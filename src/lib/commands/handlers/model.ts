import { prisma } from "@/lib/db";
import { buildModelRuntime } from "@/lib/pi/models";
import { splitModelReference } from "@/lib/pi/model-ref";
import { setChatSessionModel } from "@/lib/chat/session-model";
import type { CommandHandler, CommandOption } from "../types";

/**
 * `/model`. pick the model a chat answers with.
 *
 * The choice is stored on the `ChatSession`, whichever surface the command came
 * from. a Telegram message runs in an ordinary chat, so the phone and the
 * browser change the same setting.
 */
export const modelHandler: CommandHandler = {
  prepare: async (ctx) => {
    const session = ctx.sessionId
      ? await prisma.chatSession.findFirst({
          where: { id: ctx.sessionId, userId: ctx.userId },
          select: { modelProvider: true, modelName: true },
        })
      : null;
    return {
      title: "Model for this chat",
      options: await listModelOptions(
        ctx.userId,
        formatReference(
          session?.modelProvider && session.modelName
            ? { provider: session.modelProvider, name: session.modelName }
            : undefined,
        ),
      ),
    };
  },

  run: async (ctx, value) => {
    const reference = value === undefined ? undefined : splitModelReference(value);
    if (!reference || value === undefined) {
      return { message: `"${value}" is not a model reference.`, tone: "error" };
    }

    if (!ctx.sessionId) {
      return { message: "This message doesn't belong to a chat yet.", tone: "info" };
    }

    await setChatSessionModel({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      provider: reference.provider,
      name: reference.name,
    });
    return { message: `Model set to ${value}.`, tone: "success", refresh: "messages" };
  },
};

/** `provider:model` for a resolved model, or null when nothing is resolved. */
function formatReference(resolved: { provider: string; name: string } | undefined): string | null {
  return resolved ? `${resolved.provider}:${resolved.name}` : null;
}

/**
 * Every model the user can reach, with the one in effect marked.
 *
 * The provider prefix is only shown when the user has more than one provider
 * otherwise it is noise that makes a phone-width button wrap.
 */
async function listModelOptions(userId: string, current: string | null): Promise<CommandOption[]> {
  const { models } = await buildModelRuntime(userId);
  const multipleProviders = new Set(models.map((model) => model.provider)).size > 1;

  return models.map((model) => {
    const reference = `${model.provider}:${model.id}`;
    return {
      value: reference,
      label: multipleProviders ? `${model.provider}: ${model.name}` : model.name,
      ...(reference === current ? { current: true } : {}),
    };
  });
}
