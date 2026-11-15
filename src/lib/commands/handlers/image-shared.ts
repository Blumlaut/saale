import { prisma } from "@/lib/db";
import type { RenderedImage } from "@/lib/image-render";
import { resolveImageCapabilities } from "@/lib/pi/image-model";
import { saveAssistantMessage } from "@/lib/pi/stream-helpers";
import { normalizeImageSizes, pickImageSize } from "@/lib/providers/images/sizes";

/**
 * The parts `/image` and `/edit` share: both reach the same image model, and
 * both put the picture in the transcript as the card the matching tool draws.
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
 * Write the render into the conversation.
 *
 * The row carries the same call the matching tool would have made, so the
 * transcript draws it with the card it already knows and a reload puts it back.
 */
export async function saveRenderedMessage(input: {
  sessionId: string;
  toolName: "generate_image" | "edit_image";
  args: Record<string, unknown>;
  image: RenderedImage;
  sentence: string;
}): Promise<void> {
  const { sessionId, toolName, args, image, sentence } = input;
  const result = `${sentence}\n${JSON.stringify({ _saaleImageMeta: image })}`;

  await saveAssistantMessage({
    sessionId,
    content: "",
    toolCalls: [
      {
        id: crypto.randomUUID(),
        name: toolName,
        args,
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
