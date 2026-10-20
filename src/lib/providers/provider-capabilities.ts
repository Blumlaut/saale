/**
 * Persistence for one model's settings. what it accepts, and how big its window
 * and output cap are.
 *
 * Shared by the user and admin capability routes, which differ only in how they
 * find the provider key they act on. the validation, probing and merging are
 * the same, and a fix belongs in one place.
 *
 * Server-only: it reads the stored key and writes back to it.
 */

import { prisma } from "@/lib/db";
import { fetchEndpointListing } from "@/lib/pi/models";
import {
  detectModelCapabilities,
  mergeDetectedCapabilities,
  parseModelCapabilityMap,
  parseVisionEdit,
  serializeModelCapabilityMap,
  withModelLimits,
  withModelVision,
  withoutModelVision,
  type ModelCapabilityMap,
} from "@/lib/providers/capabilities";
import { definesProviderModels } from "@/lib/providers/config";
import { parseModelLimitEdit } from "@/lib/providers/limits";

/** Why a capability request cannot be served, or `null` when it can. */
export function rejectUnconfigurableProvider(provider: unknown): string | null {
  if (typeof provider !== "string" || provider.length === 0) return "provider is required";
  if (!definesProviderModels(provider)) {
    return "Model capabilities can only be set for the OpenAI-compatible endpoint. Pi's catalog describes every other provider's models";
  }
  return null;
}

/** A validated edit to one model's settings. */
export interface ModelSettingsEdit {
  modelId: string;
  /** Absent = leave as stored; `null` = back on automatic detection. */
  vision?: boolean | null;
  /** Absent = leave as stored; `null` = inherit the endpoint's default. */
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
}

/**
 * Validate an edit to one model's settings.
 *
 * Vision is a capability, the two limits are numbers, and an omitted key means
 * "leave it as stored". the editor writes one field at a time.
 */
export function parseModelSettingsEdit(body: {
  modelId?: unknown;
  vision?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
}): ModelSettingsEdit | { error: string } {
  const vision = parseVisionEdit(body);
  if ("error" in vision) return vision;

  const limits = parseModelLimitEdit(body);
  if ("error" in limits) return limits;

  const edit: ModelSettingsEdit = { modelId: vision.modelId };
  if (body.vision !== undefined) edit.vision = vision.vision;
  if (limits.contextWindow !== undefined) edit.contextWindow = limits.contextWindow;
  if (limits.maxOutputTokens !== undefined) edit.maxOutputTokens = limits.maxOutputTokens;

  const changed =
    edit.vision !== undefined ||
    edit.contextWindow !== undefined ||
    edit.maxOutputTokens !== undefined;
  if (!changed) {
    return { error: "vision, contextWindow or maxOutputTokens is required" };
  }

  return edit;
}

/**
 * Record one model's vision flag and limits, leaving every other model. and
 * every field the edit does not mention. alone.
 */
export async function setProviderModelSettings(options: {
  keyId: string;
  stored: unknown;
  edit: ModelSettingsEdit;
}): Promise<ModelCapabilityMap> {
  let modelCapabilities = parseModelCapabilityMap(options.stored);

  if (options.edit.vision !== undefined) {
    modelCapabilities =
      options.edit.vision === null
        ? withoutModelVision(modelCapabilities, options.edit.modelId)
        : withModelVision(modelCapabilities, options.edit.modelId, options.edit.vision);
  }

  modelCapabilities = withModelLimits(modelCapabilities, options.edit.modelId, {
    contextWindow: options.edit.contextWindow,
    maxOutputTokens: options.edit.maxOutputTokens,
  });

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
  /** Models it reported a context window for. */
  contextWindows: number;
  /** How many of those accept images. */
  visionModels: number;
  /** Models the provider lists. */
  modelCount: number;
  /** Models left unprobed. the endpoint could not answer, or the budget ran out. */
  unprobed: number;
}

/**
 * Ask a provider's endpoint what its models can do and store the answers.
 *
 * Detection overwrites what it answered for and leaves the rest alone: the
 * endpoint knows what it loaded, but a model it said nothing about must not
 * forget a limit or flag the user set by hand. Nothing is written when the
 * endpoint answered nothing at all (the usual case. only llama.cpp reports
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
  const listing = await fetchEndpointListing(options.baseUrl, options.apiKey);
  const modelIds = options.modelIds ?? listing.models.map((model) => model.id);

  // What the listing already stated, so the sweep only pays for what it cannot
  // learn there. and pays nothing at all behind a load-on-demand proxy.
  const reported: ModelCapabilityMap = {};
  for (const model of listing.models) {
    if (Object.keys(model.capabilities).length > 0) reported[model.id] = model.capabilities;
  }

  const detection = await detectModelCapabilities({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    modelIds,
    reported,
    loadOnDemand: listing.loadOnDemand,
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

  const answered = Object.values(detection.capabilities);
  return {
    modelCapabilities,
    detected: answered.length,
    contextWindows: answered.filter((c) => c.contextWindow !== undefined).length,
    visionModels: answered.filter((c) => c.vision === true).length,
    modelCount: modelIds.length,
    unprobed: detection.unprobed,
  };
}
