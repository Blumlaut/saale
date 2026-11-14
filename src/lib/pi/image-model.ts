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
