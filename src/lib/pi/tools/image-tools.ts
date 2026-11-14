/**
 * Image generation.
 *
 * One tool, backed by whichever image model the account picked. The bytes are
 * written into the user's workspace and the call returns the path, so the
 * transcript shows the picture through a file card and the model never receives
 * it back as an image block it would pay for.
 */

import type { ImageApi, ImageModel, ImagesInputContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { storeGeneratedImage } from "@/lib/image-attachment";
import { loadImageModel } from "@/lib/pi/image-model";
import { defineStructuredTool } from "./tool-result";

export const IMAGE_TOOL_NAME = "generate_image";

/** Largest reference image sent back to the model's endpoint. */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;

const GENERATED_IMAGE_SCHEMA = Type.Object({
  path: Type.String({ description: "Workspace path of the rendered image." }),
  model: Type.String(),
  provider: Type.String(),
  width: Type.Number(),
  height: Type.Number(),
  /** What the render cost, when the provider reports a price. */
  cost: Type.Optional(Type.Number()),
});

/**
 * The reference image, read out of the user's workspace.
 *
 * A path that is not there, or is not an image, fails the call with the reason
 * rather than generating something else.
 */
async function readReferenceImage(
  userId: string,
  filePath: string,
  sessionId: string,
): Promise<ImagesInputContent> {
  const file = await readWorkspaceFile(userId, filePath, { session: sessionId });
  if (!file.mimeType.startsWith("image/")) {
    throw new Error(`${file.fileName} is not an image (${file.mimeType})`);
  }
  if (file.size > MAX_REFERENCE_BYTES) {
    throw new Error(`${file.fileName} is larger than 15MB, which no endpoint accepts`);
  }

  return {
    type: "image",
    data: Buffer.from(file.buffer).toString("base64"),
    mimeType: file.mimeType,
  };
}

export function createImageTools(userId: string, sessionId: string) {
  return defineStructuredTool({
    name: IMAGE_TOOL_NAME,
    label: "Generate Image",
    description:
      "Render an image from a text prompt with the account's image model. The picture is saved " +
      "to the workspace and shown to the user in the chat, and the call returns its path. Pass " +
      "`image` to work from a picture already in the workspace: the endpoint then edits it. A " +
      "render takes from seconds to a few minutes, so make one call per picture rather than " +
      "several at once.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "What to render. Describe the subject, style and framing you want.",
      }),
      image: Type.Optional(
        Type.String({
          description:
            "Workspace path of a reference image to edit or build on, relative to the chat's " +
            "worktree. Omit it to render from the prompt alone.",
        }),
      ),
    }),
    outputSchema: GENERATED_IMAGE_SCHEMA,
    execute: async (_toolCallId, params, signal) => {
      const { prompt, image } = params;

      const resolved = await loadImageModel(userId);
      if (!resolved) {
        throw new Error(
          "No image model is configured. Pick one under Settings → Models before rendering.",
        );
      }
      const { runtime, model, pick } = resolved;

      const input: ImagesInputContent[] = [{ type: "text", text: prompt }];
      if (image) input.push(await readReferenceImage(userId, image, sessionId));

      const result = await runtime.generateImages(
        model as ImageModel<ImageApi>,
        { input },
        signal ? { signal } : {},
      );

      if (result.stopReason !== "stop") {
        throw new Error(result.errorMessage ?? `The image model stopped: ${result.stopReason}`);
      }

      const rendered = result.output.find(
        (block): block is Extract<typeof block, { type: "image" }> => block.type === "image",
      );
      if (!rendered) throw new Error("The image model returned no image.");

      const stored = await storeGeneratedImage(userId, Buffer.from(rendered.data, "base64"));
      const cost = result.usage?.cost?.total;
      const size = `${stored.width}×${stored.height}`;

      return {
        value: {
          path: stored.storagePath,
          model: model.id,
          provider: pick.provider,
          width: stored.width,
          height: stored.height,
          ...(typeof cost === "number" && cost > 0 ? { cost } : {}),
        },
        text:
          `Rendered "${prompt}" with ${model.name} (${size}). Saved to ${stored.storagePath} ` +
          "and shown to the user.",
        meta: {
          _saaleImageMeta: {
            path: stored.storagePath,
            model: model.id,
            provider: pick.provider,
            prompt,
            width: stored.width,
            height: stored.height,
            ...(typeof cost === "number" && cost > 0 ? { cost } : {}),
          },
        },
      };
    },
  });
}
