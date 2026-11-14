/**
 * `AppSettings` as the account's pages receive it.
 *
 * Every response that carries the whole object comes through here: the client
 * replaces its state with whatever a save answers, so a field present in one
 * response and missing from another disappears until the next load. The return
 * type is the client's contract, which is what makes a forgotten column a
 * `tsc` error rather than a blank row in the UI.
 */

import type { AppSettings } from "@prisma/client";
import { readInstanceDecisionModel } from "@/lib/pi/decision-model";
import { readInstanceImageModel } from "@/lib/pi/image-model";
import { formatModelReference } from "@/lib/pi/model-ref";
import { normalizeToolExposure } from "@/lib/pi/tool-exposure";
import type { ToolConfig, ToolExposureConfig } from "@/lib/pi/tool-categories";
import type { ToolPolicy } from "@/lib/pi/tool-infos";
import type { NotificationPreferences } from "@/lib/notifications/preferences";

export interface PurposeModelSelection {
  provider: string;
  model: string;
}

export interface UserSettings {
  defaultModelProvider: string;
  defaultModelName: string;
  defaultThinkingLevel: string;
  theme: string;
  /** Collapse a turn's reasoning and tool calls into one compact line each. */
  compactActivity: boolean;
  /** Send Telegram a line for every tool call, above the agent's answer. */
  telegramToolNotices: boolean;
  agentCustomInstructions: string | null;
  /** Instructions for coder chats, in place of `agentCustomInstructions`. */
  coderCustomInstructions: string | null;
  emailWritingStyle: string | null;
  purposeModelOverrides: Record<string, PurposeModelSelection> | null;
  disabledModels: string[] | null; // Array of "provider:modelId" strings
  defaultToolConfig: ToolConfig | null;
  /** Category on/off for new coder chats. */
  coderToolConfig: ToolConfig | null;
  toolPolicies: Record<string, ToolPolicy> | null;
  toolExposure: ToolExposureConfig | null;
  /** Decision model that judges what Auto would run, as "provider:model". */
  approvalDecisionModel: string | null;
  /**
   * Read-only: the instance's decision model, which this account follows while
   * its own pick is empty.
   */
  instanceApprovalDecisionModel: string | null;
  /** Image model the agent renders with, as "provider:model". */
  imageModel: string | null;
  /** Sizes this account's renders may use, as "WxH". The first is the default. */
  imageSizes: string[];
  /** Read-only: the instance's image model, which this account follows while its own pick is empty. */
  instanceImageModel: string | null;
  /** Sparse push switches: a category equal to its default is left out. */
  pushNotifications: Partial<NotificationPreferences> | null;
}

/** The row as the account reads it, with the instance values it falls back to. */
export async function serializeUserSettings(settings: AppSettings): Promise<UserSettings> {
  const [instanceDecisionModel, instanceImageModel] = await Promise.all([
    readInstanceDecisionModel(),
    readInstanceImageModel(),
  ]);
  // The JSON columns are validated by the registry that writes them, so they
  // hold the shapes the client declares.
  return {
    defaultModelProvider: settings.defaultModelProvider,
    defaultModelName: settings.defaultModelName,
    defaultThinkingLevel: settings.defaultThinkingLevel,
    theme: settings.theme,
    compactActivity: settings.compactActivity,
    telegramToolNotices: settings.telegramToolNotices,
    agentCustomInstructions: settings.agentCustomInstructions,
    coderCustomInstructions: settings.coderCustomInstructions,
    emailWritingStyle: settings.emailWritingStyle,
    purposeModelOverrides: settings.purposeModelOverrides as Record<
      string,
      PurposeModelSelection
    > | null,
    disabledModels: settings.disabledModels as string[] | null,
    defaultToolConfig: settings.defaultToolConfig as ToolConfig | null,
    coderToolConfig: settings.coderToolConfig as ToolConfig | null,
    toolPolicies: settings.toolPolicies as Record<string, ToolPolicy> | null,
    toolExposure: normalizeToolExposure(settings.toolExposure),
    approvalDecisionModel: settings.approvalDecisionModel,
    instanceApprovalDecisionModel: instanceDecisionModel
      ? formatModelReference(instanceDecisionModel.provider, instanceDecisionModel.id)
      : null,
    imageModel: settings.imageModel,
    imageSizes: settings.imageSizes,
    instanceImageModel: instanceImageModel
      ? formatModelReference(instanceImageModel.provider, instanceImageModel.id)
      : null,
    pushNotifications: settings.pushNotifications as Partial<NotificationPreferences> | null,
  };
}
