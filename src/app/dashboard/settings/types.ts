// Re-export shared types
export type { EmailAccount } from "@/types/shared";
import type { ToolConfig, ToolExposureConfig } from "@/lib/pi/tool-categories";
export type { ToolConfig };
export type { ToolExposureConfig };
import type { ToolPolicy } from "@/lib/pi/tool-infos";
export type { ToolPolicy };

export interface PurposeModelSelection {
  provider: string;
  model: string;
}

export interface UserSettings {
  defaultModelProvider: string;
  defaultModelName: string;
  defaultThinkingLevel: string;
  theme: string;
  agentCustomInstructions: string | null;
  emailWritingStyle: string | null;
  purposeModelOverrides: Record<string, PurposeModelSelection> | null;
  disabledModels: string[] | null; // Array of "provider:modelId" strings
  defaultToolConfig: ToolConfig | null;
  toolPolicies: Record<string, ToolPolicy> | null;
  toolExposure: ToolExposureConfig | null;
}

export interface AvailableModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** Whether the resolved model definition accepts image input. */
  vision?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost: { input: number; output: number };
}

export interface AvailableProvider {
  id: string;
  name: string;
  modelCount: number;
  /** Whether this provider's per-model metadata (limits, capabilities) is editable. */
  modelsConfigurable?: boolean;
}
