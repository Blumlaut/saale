// Re-export shared types
export type { EmailAccount } from "@/types/shared";
import type { ToolConfig } from "@/lib/pi/tool-categories";
export type { ToolConfig };

export interface PurposeModelSelection {
  provider: string;
  model: string;
}

export type ToolPolicy = "off" | "ask" | "yolo";

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
}

export interface ConfiguredProvider {
  id: string;
  provider: string;
  label: string;
  configured: boolean;
  isGlobal: boolean;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  configured?: boolean;
}

export interface AvailableModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost: { input: number; output: number };
}

export interface AvailableProvider {
  id: string;
  name: string;
  modelCount: number;
}
