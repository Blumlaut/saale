/**
 * The models that do not chat.
 *
 * Pi keeps classifiers and image models in lists of their own, apart from chat
 * models, and Saale stores one `provider:model` pick per slot. Listing the
 * models a slot can call, reading the stored pick and resolving it to a model
 * are the same steps for every slot, so they live here. What a slot is called
 * and how its model is called stay with the feature that calls it.
 */

import type { ClassifierApi, ClassifierModel, ImageApi, ImageModel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isModelAllowed, readGlobalModelConfig } from "@/lib/providers/model-availability";
import { splitModelReference } from "./model-ref";

/** The model types a slot can name. */
export type SlotModelType = "classifier" | "image";

export interface ModelSlot {
  /** Stable id: the settings key suffix (`models.image`) and the picker's name. */
  id: string;
  /** Which of Pi's model lists this slot draws from. */
  type: SlotModelType;
  label: string;
  description: string;
}

/** Every slot, with the label and description the settings UI shows. */
export const MODEL_SLOTS = {
  decision: {
    id: "decision",
    type: "classifier",
    label: "Approval decision model",
    description: "Judges the tool calls the Auto policy would run on its own.",
  },
  image: {
    id: "image",
    type: "image",
    label: "Image model",
    description: "Generates an image when the agent is asked for one.",
  },
} as const satisfies Record<string, ModelSlot>;

export type ModelSlotId = keyof typeof MODEL_SLOTS;

/** A model a picker can offer: an id, and what to call it. */
export interface SlotModelSummary {
  id: string;
  name: string;
}

/** A slot's pick, in the form the settings store and the runtime resolve. */
export interface SlotModelPick {
  provider: string;
  id: string;
}

/** `provider:model` as stored in the settings, or null when nothing is picked. */
export function parseSlotModelPick(reference: string | null | undefined): SlotModelPick | null {
  const parsed = splitModelReference(reference ?? null);
  return parsed ? { provider: parsed.provider, id: parsed.name } : null;
}

/**
 * The models one slot can call, grouped by provider.
 *
 * Pi's list for the slot's type, kept to the providers this runtime has
 * credentials for, minus the models the admin switched off.
 */
export async function listSlotModels(
  runtime: ModelRuntime,
  slot: ModelSlot,
): Promise<Record<string, SlotModelSummary[]>> {
  const globalConfig = await readGlobalModelConfig();

  try {
    const available = await runtime.getAvailableOfType(slot.type);
    const byProvider: Record<string, SlotModelSummary[]> = {};
    for (const model of available) {
      if (!isModelAllowed(globalConfig, model.provider, model.id)) continue;
      (byProvider[model.provider] ??= []).push({ id: model.id, name: model.name });
    }
    return byProvider;
  } catch (err) {
    console.error(`Failed to list the ${slot.label.toLowerCase()} models:`, err);
    return {};
  }
}

/**
 * A slot's model in this runtime, or undefined when the pick names a model Pi
 * does not have.
 */
export function slotModel(
  runtime: ModelRuntime,
  slot: ModelSlot,
  pick: SlotModelPick,
): ImageModel<ImageApi> | ClassifierModel<ClassifierApi> | undefined {
  return runtime.getModelOfType(slot.type, pick.provider, pick.id);
}
