import { prisma } from "@/lib/db";
import { renderImage, type RenderedImage } from "@/lib/image-render";
import { resolveImageCapabilities } from "@/lib/pi/image-model";
import { publishSessionEvent } from "@/lib/pi/session-events";
import { saveAssistantMessage } from "@/lib/pi/stream-helpers";
import { imageSizeShape, normalizeImageSizes, pickImageSize } from "@/lib/providers/images/sizes";
import type { CommandOption } from "../types";

/**
 * The parts `/image` and `/edit` share: both reach the same image model, and
 * both show their work as the card the matching tool draws.
 */

/** The account's image model, or the reason a render cannot happen. */
export async function imageModelFor(
  userId: string,
  mode: "generate" | "edit",
): Promise<{ ok: true; sizes: string[] } | { ok: false; message: string }> {
  const capabilities = await resolveImageCapabilities(userId);
  if (!capabilities.generate) {
    return {
      ok: false,
      message: "No image model is configured. Pick one under Settings → Models.",
    };
  }
  if (mode === "edit" && !capabilities.edit) {
    return {
      ok: false,
      message: "This image model only renders. Pick one that takes a picture to edit.",
    };
  }
  return { ok: true, sizes: normalizeImageSizes(capabilities.sizes) };
}

/**
 * The resolutions the account's image model renders at, as choices.
 *
 * The list belongs to the model, so only the server has it: the composer asks
 * for it while a size is being picked. The first entry is the model's default,
 * and each one is named by its shape, so a row reads "portrait" next to the
 * size rather than repeating the numbers.
 */
export async function sizeOptions(
  userId: string,
  mode: "generate" | "edit",
): Promise<CommandOption[]> {
  const model = await imageModelFor(userId, mode);
  if (!model.ok) return [];

  return model.sizes.map((size, index) => ({
    value: size,
    label: imageSizeShape(size),
    ...(index === 0 ? { description: "The model's default" } : {}),
  }));
}

/** The size to render at, or the list the user may choose from instead. */
export function renderSize(
  sizes: readonly string[],
  requested: string | undefined,
): { size: string } | { error: string } {
  const wanted = requested ? pickImageSize(sizes, requested) : sizes[0]!;
  if (requested && wanted !== requested) {
    return { error: `This model renders at ${sizes.join(", ")}.` };
  }
  return { size: wanted };
}

/**
 * Render one picture, showing it in the transcript the way the agent's tool
 * does: the call's card appears first and shimmers, then holds the picture.
 *
 * The row is written before the endpoint is called, so a render that takes
 * minutes looks like work in progress rather than a command that did nothing,
 * and every connected client is told to reload so the card shows up at once.
 */
export async function renderWithCard(input: {
  userId: string;
  sessionId: string;
  prompt: string;
  references?: readonly string[] | undefined;
  size: string;
  verb: "Rendered" | "Edited";
  toolName: "generate_image" | "edit_image";
  args: Record<string, unknown>;
}): Promise<{ image: RenderedImage; sentence: string }> {
  const callId = crypto.randomUUID();
  const { id: messageId } = await saveAssistantMessage({
    sessionId: input.sessionId,
    content: "",
    toolCalls: [
      {
        id: callId,
        name: input.toolName,
        args: input.args,
        result: undefined,
        isError: undefined,
        status: "running",
      },
    ],
  });
  await publishMessagesChanged(input.sessionId);

  try {
    const { image, sentence } = await renderImage({
      userId: input.userId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      references: input.references,
      size: input.size,
      verb: input.verb,
    });

    await saveAssistantMessage({
      sessionId: input.sessionId,
      messageId,
      content: "",
      toolCalls: [
        {
          id: callId,
          name: input.toolName,
          args: input.args,
          result: `${sentence}\n${JSON.stringify({ _saaleImageMeta: image })}`,
          isError: false,
        },
      ],
    });
    await publishMessagesChanged(input.sessionId);
    await bumpActivity(input.sessionId);

    return { image, sentence };
  } catch (err) {
    // The card must not shimmer forever, so the same row says what went wrong.
    await saveAssistantMessage({
      sessionId: input.sessionId,
      messageId,
      content: "",
      errorMessage: err instanceof Error ? err.message : "The render failed.",
      toolCalls: [
        {
          id: callId,
          name: input.toolName,
          args: input.args,
          result: err instanceof Error ? err.message : "The render failed.",
          isError: true,
        },
      ],
    }).catch((saveErr) => {
      console.error(`Failed to record the failed render in ${input.sessionId}:`, saveErr);
    });
    await publishMessagesChanged(input.sessionId);
    throw err;
  }
}

/** Tell every client watching the chat that its transcript moved. */
async function publishMessagesChanged(sessionId: string): Promise<void> {
  await publishSessionEvent(sessionId, "messages_changed", {}).catch((err) => {
    console.error(`Failed to publish the render change for ${sessionId}:`, err);
  });
}

/** A rendered picture is new content, so the chat moves up in the session list. */
async function bumpActivity(sessionId: string): Promise<void> {
  await prisma.chatSession
    .update({ where: { id: sessionId }, data: { lastActivityAt: new Date() } })
    .catch((err) => {
      console.error(`Failed to bump lastActivityAt after a render in ${sessionId}:`, err);
    });
}
