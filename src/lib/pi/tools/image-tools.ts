/**
 * Image generation and editing.
 *
 * Two tools over whichever image model the account picked: one renders from a
 * prompt, one works from a picture already in the workspace. The bytes are
 * written into the user's workspace and the call returns the path, so the
 * transcript shows the picture through a file card and the model never receives
 * it back as an image block it would pay for.
 */

import type { ImageApi, ImageModel, ImagesInputContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { storeGeneratedImage } from "@/lib/image-attachment";
import { loadImageModel } from "@/lib/pi/image-model";
import { normalizeImageSizes, pickImageSize } from "@/lib/providers/images/sizes";
import { defineStructuredTool, type ToolOutcome } from "./tool-result";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
export const EDIT_IMAGE_TOOL_NAME = "edit_image";

/** Which image models take a picture to edit, for the tools that need one. */
export const IMAGE_TOOL_NAMES = [GENERATE_IMAGE_TOOL_NAME, EDIT_IMAGE_TOOL_NAME] as const;

/** Largest reference image sent back to the model's endpoint. */
const MAX_REFERENCE_BYTES = 15 * 1024 * 1024;

/**
 * How many pictures one edit may carry.
 *
 * Combining two pictures is the usual case: a subject and a setting, or a face
 * and a style. The endpoints cap it too, and a request with more references
 * than the model was trained on renders whatever it manages rather than saying
 * no, so the ceiling is here.
 */
const MAX_REFERENCES = 4;

const GENERATED_IMAGE_SCHEMA = Type.Object({
  path: Type.String({ description: "Workspace path of the rendered image." }),
  model: Type.String(),
  provider: Type.String(),
  width: Type.Number(),
  height: Type.Number(),
  /** What the render cost, when the provider reports a price. */
  cost: Type.Optional(Type.Number()),
});

type GeneratedImage = {
  path: string;
  model: string;
  provider: string;
  width: number;
  height: number;
  cost?: number;
};

/**
 * The `size` argument, offering the sizes the model was given.
 *
 * The endpoint renders whatever it is asked for, so the agent gets the model's
 * own list rather than a free string the server would reject or silently round.
 */
function sizeParameter(sizes: readonly string[]) {
  const list = normalizeImageSizes(sizes);
  return Type.Optional(
    Type.String({
      enum: list,
      description:
        `Resolution as "WxH". Omit it for ${list[0]}, the model's default. ` +
        `Anything more square, tall or wide has to be one of: ${list.join(", ")}.`,
    }),
  );
}

/**
 * The reference image, read out of the user's workspace.
 *
 * A path that is not there, or is not an image, fails the call with the reason
 * rather than rendering something else.
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

/**
 * Render one picture and store it.
 *
 * Both tools end here: the difference between them is a reference image, which
 * turns the request into an edit on the endpoint.
 */
async function renderImage(options: {
  userId: string;
  sessionId: string;
  prompt: string;
  /** Workspace paths of the pictures to work from, in the order the prompt names them. */
  references?: readonly string[] | undefined;
  /** The resolution the agent asked for, already resolved against the account's list. */
  size?: string | undefined;
  signal?: AbortSignal | undefined;
  /** What the model did, for the sentence the model reads. */
  verb: "Rendered" | "Edited";
}): Promise<ToolOutcome<GeneratedImage, undefined>> {
  const { userId, sessionId, prompt, references = [], size, signal, verb } = options;

  const resolved = await loadImageModel(userId);
  if (!resolved) {
    throw new Error(
      "No image model is configured. Pick one under Settings → Models before rendering.",
    );
  }
  const { runtime, model, pick } = resolved;

  const input: ImagesInputContent[] = [{ type: "text", text: prompt }];
  if (references.length > 0) {
    if (!model.input.includes("image")) {
      throw new Error(
        `${model.name} renders from a prompt alone, so it cannot edit a picture. Use generate_image.`,
      );
    }
    // Order matters: the model reads them in this order and the prompt refers
    // to them by position.
    for (const reference of references) {
      input.push(await readReferenceImage(userId, reference, sessionId));
    }
  }

  const result = await runtime.generateImages(
    model as ImageModel<ImageApi>,
    { input },
    {
      ...(signal ? { signal } : {}),
      // `metadata` is Pi's channel for provider-neutral request fields.
      ...(size ? { metadata: { size } } : {}),
    },
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
  const priced = typeof cost === "number" && cost > 0 ? { cost } : {};

  return {
    value: {
      path: stored.storagePath,
      model: model.id,
      provider: pick.provider,
      width: stored.width,
      height: stored.height,
      ...priced,
    },
    text:
      `${verb} "${prompt}" with ${model.name} (${stored.width}×${stored.height}). ` +
      `Saved to ${stored.storagePath} and shown to the user.`,
    meta: {
      _saaleImageMeta: {
        path: stored.storagePath,
        model: model.id,
        provider: pick.provider,
        prompt,
        width: stored.width,
        height: stored.height,
        ...priced,
      },
    },
  };
}

/** Render a new picture from a prompt. */
function createGenerateImageTool(userId: string, sessionId: string, sizes: readonly string[]) {
  return defineStructuredTool({
    name: GENERATE_IMAGE_TOOL_NAME,
    label: "Generate Image",
    description:
      "Render an image from a text prompt with the account's image model. The picture is saved " +
      "to the workspace and shown to the user in the chat, and the call returns its path. " +
      "A render takes from seconds to a few minutes, so make one call per picture rather than " +
      "several at once.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "What to render. Describe the subject, style and framing you want.",
      }),
      size: sizeParameter(sizes),
    }),
    outputSchema: GENERATED_IMAGE_SCHEMA,
    execute: async (_toolCallId, params, signal) =>
      renderImage({
        userId,
        sessionId,
        prompt: params.prompt,
        // A size outside the list is not the endpoint's to guess at.
        size: pickImageSize(sizes, params.size),
        signal,
        verb: "Rendered",
      }),
  });
}

/**
 * Edit a picture already in the workspace, which is the same endpoint's
 * `/v1/images/edits` call.
 */
function createEditImageTool(userId: string, sessionId: string, sizes: readonly string[]) {
  return defineStructuredTool({
    name: EDIT_IMAGE_TOOL_NAME,
    label: "Edit Image",
    description:
      "Change a picture that is already in the workspace, or combine it with others: the " +
      "account's image model renders a new version from those pictures plus your instructions, " +
      "and the originals stay as they are. The result is saved to the workspace, shown to the " +
      "user, and its path returned. Takes from seconds to a few minutes.",
    parameters: Type.Object({
      images: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: MAX_REFERENCES,
        description:
          "Workspace paths of the pictures to work from, relative to the chat's worktree. One " +
          "picture edits it; two or more combine them, and the model sees them in this order, " +
          'so name them by position in the prompt ("the person from the second picture, in ' +
          'the room from the first"). Read them first if you do not know what they show.',
      }),
      prompt: Type.String({
        description:
          "What to change and what the result should look like. The endpoint keeps the parts " +
          "you do not name.",
      }),
      size: sizeParameter(sizes),
    }),
    outputSchema: GENERATED_IMAGE_SCHEMA,
    execute: async (_toolCallId, params, signal) =>
      renderImage({
        userId,
        sessionId,
        prompt: params.prompt,
        references: params.images,
        size: pickImageSize(sizes, params.size),
        signal,
        verb: "Edited",
      }),
  });
}

/**
 * The image tools this account can use.
 *
 * `edit` needs a model that takes a picture, so a diffusion server told it only
 * answers prompts gets the one tool it can serve.
 */
export function createImageTools(
  userId: string,
  sessionId: string,
  options: { edit: boolean; sizes: readonly string[] },
) {
  const sizes = normalizeImageSizes(options.sizes);
  const generate = createGenerateImageTool(userId, sessionId, sizes);
  return options.edit ? [generate, createEditImageTool(userId, sessionId, sizes)] : [generate];
}
