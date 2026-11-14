// Re-export shared types
export type { EmailAccount } from "@/types/shared";
import type { ToolConfig, ToolExposureConfig } from "@/lib/pi/tool-categories";
export type { ToolConfig };
export type { ToolExposureConfig };
import type { ToolPolicy } from "@/lib/pi/tool-infos";
export type { ToolPolicy };
import type { NotificationPreferences } from "@/lib/notifications/preferences";
export type { NotificationPreferences };

// The settings contract is declared beside the serializer that answers with it.
export type { PurposeModelSelection, UserSettings } from "@/lib/settings/user-view";

export interface AvailableModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** Whether the resolved model definition accepts image input. */
  vision?: boolean;
  /** Whether the user marked this endpoint model as one that generates images. */
  image?: boolean;
  /** Whether it takes a picture to edit. Absent means it does. */
  imageInput?: boolean;
  /** Resolutions the admin picked for this image model. Absent means the default. */
  imageSizes?: string[];
  /** Context window Pi will compact against. */
  contextWindow?: number;
  /** Output cap Pi sends as the request's token budget. */
  maxOutputTokens?: number;
  /** Limits the user recorded for this model; an unset field inherits. */
  overrides?: { contextWindow?: number; maxOutputTokens?: number };
  cost?: { input: number; output: number };
}

export interface AvailableProvider {
  id: string;
  name: string;
  modelCount: number;
  /** Whether this provider's per-model metadata (limits, capabilities) is editable. */
  modelsConfigurable?: boolean;
}
