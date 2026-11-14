/**
 * Image generation and editing.
 *
 * Two tools over whichever image model the account picked: one renders from a
 * prompt, one works from a picture already in the workspace. The bytes are
 * written into the user's workspace and the call returns the path, so the
 * transcript shows the picture through a file card and the model never receives
 * it back as an image block it would pay for.
 */

import { Type } from "typebox";
import { MAX_REFERENCES, renderImage } from "@/lib/image-render";
import { normalizeImageSizes, pickImageSize } from "@/lib/providers/images/sizes";
import { defineStructuredTool, type ToolOutcome } from "./tool-result";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";
export const EDIT_IMAGE_TOOL_NAME = "edit_image";

/** Which image models take a picture to edit, for the tools that need one. */
export const IMAGE_TOOL_NAMES = [GENERATE_IMAGE_TOOL_NAME, EDIT_IMAGE_TOOL_NAME] as const;

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

/** One render, in the shape a tool result takes: the value, its sentence, its metadata. */
async function renderToOutcome(options: {
  userId: string;
  sessionId: string;
  prompt: string;
  references?: readonly string[] | undefined;
  size?: string | undefined;
  signal?: AbortSignal | undefined;
  verb: "Rendered" | "Edited";
}): Promise<ToolOutcome<GeneratedImage, undefined>> {
  const { image, sentence } = await renderImage(options);
  const { prompt: _prompt, ...value } = image;

  return {
    value,
    text: sentence,
    meta: { _saaleImageMeta: image },
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
      renderToOutcome({
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
      renderToOutcome({
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
