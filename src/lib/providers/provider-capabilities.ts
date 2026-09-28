/**
 * Persistence for per-model capabilities.
 *
 * Shared by the user and admin capability routes, which differ only in how they
 * find the provider key they act on — the validation, probing and merging are
 * the same, and a fix belongs in one place.
 *
 * Server-only: it reads the stored key and writes back to it.
 */

import { prisma } from "@/lib/db";
import { fetchOpenAIModels } from "@/lib/pi/models";
import {
  detectModelCapabilities,
  mergeDetectedCapabilities,
  parseModelCapabilityMap,
  serializeModelCapabilityMap,
  withModelVision,
  withoutModelVision,
  type ModelCapabilityMap,
} from "@/lib/providers/capabilities";
import { definesProviderModels } from "@/lib/providers/config";

/** Why a capability request cannot be served, or `null` when it can. */
export function rejectUnconfigurableProvider(provider: unknown): string | null {
  if (typeof provider !== "string" || provider.length === 0) return "provider is required";
  if (!definesProviderModels(provider)) {
    return "Model capabilities can only be set for providers whose models Saale discovers (OpenAI-compatible, OpenRouter, Together, Fireworks, Hugging Face)";
  }
  return null;
}

/** Record one model's vision flag, or put it back on automatic detection. */
export async function setProviderModelVision(options: {
  keyId: string;
  stored: unknown;
  modelId: string;
  /** `null` resets the model to automatic detection. */
  vision: boolean | null;
}): Promise<ModelCapabilityMap> {
  const stored = parseModelCapabilityMap(options.stored);
  const modelCapabilities =
    options.vision === null
      ? withoutModelVision(stored, options.modelId)
      : withModelVision(stored, options.modelId, options.vision);

  await prisma.providerApiKey.update({
    where: { id: options.keyId },
    data: { modelCapabilities: serializeModelCapabilityMap(modelCapabilities) },
  });

  return modelCapabilities;
}

export interface CapabilityDetectionSummary {
  modelCapabilities: ModelCapabilityMap;
  /** Models the endpoint reported capabilities for. */
  detected: number;
  /** How many of those accept images. */
  visionModels: number;
  /** Models the provider lists. */
  modelCount: number;
  /** Models left unprobed — the endpoint could not answer, or the budget ran out. */
  unprobed: number;
}

/**
 * Ask a provider's endpoint what its models can do and store the answers.
 *
 * Detection overwrites what it answered for and leaves the rest alone: the
 * endpoint knows what it loaded, but a model it said nothing about must not
 * forget a flag the user set by hand. Nothing is written when the endpoint
 * answered nothing at all (the usual case — only llama.cpp reports
 * capabilities), so an import of an ordinary OpenAI-compatible endpoint does
 * not rewrite the stored map to say the same thing.
 */
export async function detectAndStoreProviderCapabilities(options: {
  keyId: string;
  stored: unknown;
  baseUrl: string;
  apiKey?: string | undefined;
  /** Model ids to attribute answers to; discovered from the endpoint when omitted. */
  modelIds?: string[] | undefined;
}): Promise<CapabilityDetectionSummary> {
  const modelIds = options.modelIds ?? (await fetchOpenAIModels(options.baseUrl, options.apiKey));
  const detection = await detectModelCapabilities({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    modelIds,
  });

  const modelCapabilities = mergeDetectedCapabilities(
    parseModelCapabilityMap(options.stored),
    detection.capabilities,
  );

  if (Object.keys(detection.capabilities).length > 0) {
    await prisma.providerApiKey.update({
      where: { id: options.keyId },
      data: { modelCapabilities: serializeModelCapabilityMap(modelCapabilities) },
    });
  }

  return {
    modelCapabilities,
    detected: Object.keys(detection.capabilities).length,
    visionModels: Object.values(detection.capabilities).filter((c) => c.vision === true).length,
    modelCount: modelIds.length,
    unprobed: detection.unprobed,
  };
}
