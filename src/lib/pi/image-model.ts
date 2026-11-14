/**
 * The image model the agent renders with.
 *
 * A pick is stored per account and falls back to the instance default. Nothing
 * is auto-picked: without a model the `generate_image` tool is left out of the
 * session altogether, so an image is never generated (and billed) for a user who
 * never chose one.
 */

import type { ImageApi, ImageModel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { normalizeImageSizes } from "@/lib/providers/images/sizes";
import { MODEL_SLOTS, parseSlotModelPick, slotModel, type SlotModelPick } from "./model-slots";
import { buildModelRuntime } from "./models";

/** The instance default, for an account that has not picked one. */
export async function readInstanceImageModel(): Promise<SlotModelPick | null> {
  const admin = await prisma.adminSettings.findUnique({
    where: { id: "global" },
    select: { imageModel: true },
  });
  return parseSlotModelPick(admin?.imageModel);
}

/** The image model that governs one account: its own pick, else the instance default. */
export async function resolveImageModel(userId: string): Promise<SlotModelPick | null> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { imageModel: true },
  });
  return parseSlotModelPick(settings?.imageModel) ?? (await readInstanceImageModel());
}

/**
 * The resolutions this account renders at, the first one being the default.
 *
 * A render without a size is whatever the endpoint picks on its own, which for
 * a diffusion server is far below the resolution the model was trained on.
 */
export async function resolveImageSizes(userId: string): Promise<string[]> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { imageSizes: true },
  });
  return normalizeImageSizes(settings?.imageSizes);
}

/**
 * What this account can do with images.
 *
 * `edit` comes from the model definition's `input`, which the endpoint's own
 * settings decide for a custom model: a diffusion server that serves no
 * `/v1/images/edits` is marked as taking a prompt alone.
 */
export interface ImageCapabilities {
  generate: boolean;
  edit: boolean;
}

/**
 * Resolve what the account's image model can do.
 *
 * Takes the runtime a caller already has, since a session build has one; a
 * caller without one builds it here, and only when a model is picked.
 */
export async function resolveImageCapabilities(
  userId: string,
  runtime?: ModelRuntime,
): Promise<ImageCapabilities> {
  const pick = await resolveImageModel(userId);
  if (!pick) return { generate: false, edit: false };

  const modelRuntime = runtime ?? (await buildModelRuntime(userId)).modelRuntime;
  const model = slotModel(modelRuntime, MODEL_SLOTS.image, pick);
  if (!model || model.type !== "image") {
    console.error(`The configured image model is not in the catalog: ${pick.provider}/${pick.id}`);
    return { generate: false, edit: false };
  }

  return { generate: true, edit: model.input.includes("image") };
}

/** The model to call, with the runtime whose credentials it needs. */
export interface ResolvedImageModel {
  runtime: ModelRuntime;
  model: ImageModel<ImageApi>;
  pick: SlotModelPick;
}

/**
 * Resolve the account's image model against its own providers.
 *
 * @returns The model, or null when nothing is picked or Pi has no such model in
 *   this account's catalog.
 */
export async function loadImageModel(userId: string): Promise<ResolvedImageModel | null> {
  const pick = await resolveImageModel(userId);
  if (!pick) return null;

  const { modelRuntime } = await buildModelRuntime(userId);
  const model = slotModel(modelRuntime, MODEL_SLOTS.image, pick);
  if (!model || model.type !== "image") {
    console.error(`The configured image model is not in the catalog: ${pick.provider}/${pick.id}`);
    return null;
  }
  return { runtime: modelRuntime, model, pick };
}
