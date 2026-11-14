/**
 * One render against the account's image model.
 *
 * Shared by the agent's image tools and `/image`, which renders without a model
 * turn: both end in the same endpoint call, the same workspace file and the same
 * sentence the transcript reads.
 */

import type { ImageApi, ImageModel, ImagesInputContent } from "@earendil-works/pi-ai";
import { readWorkspaceFile } from "@/lib/files/workspace-file";
import { storeGeneratedImage } from "@/lib/image-attachment";
import { loadImageModel } from "@/lib/pi/image-model";

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
export const MAX_REFERENCES = 4;

/** A picture on disk, and what the transcript needs to show it. */
export interface RenderedImage {
  path: string;
  model: string;
  provider: string;
  prompt: string;
  width: number;
  height: number;
  /** What the render cost, when the provider reports a price. */
  cost?: number;
}

export interface RenderImageOptions {
  userId: string;
  sessionId: string;
  prompt: string;
  /** Workspace paths of the pictures to work from, in the order the prompt names them. */
  references?: readonly string[] | undefined;
  /** The resolution to render at, already resolved against the model's list. */
  size?: string | undefined;
  signal?: AbortSignal | undefined;
  /** What the model did, for the sentence the model reads. */
  verb: "Rendered" | "Edited";
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
 * A reference image turns the request into an edit on the endpoint; the rest of
 * the call is the same.
 */
export async function renderImage(
  options: RenderImageOptions,
): Promise<{ image: RenderedImage; sentence: string }> {
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
    image: {
      path: stored.storagePath,
      model: model.id,
      provider: pick.provider,
      prompt,
      width: stored.width,
      height: stored.height,
      ...priced,
    },
    sentence:
      `${verb} "${prompt}" with ${model.name} (${stored.width}×${stored.height}). ` +
      `Saved to ${stored.storagePath} and shown to the user.`,
  };
}
