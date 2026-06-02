// Re-export shared types
export type { EmailAccount } from "@/types/shared";

export interface PurposeModelSelection {
  provider: string;
  model: string;
}

export interface UserSettings {
  defaultModelProvider: string;
  defaultModelName: string;
  defaultThinkingLevel: string;
  theme: string;
  agentSystemPrompt: string | null;
  emailWritingStyle: string | null;
  purposeModelOverrides: Record<string, PurposeModelSelection> | null;
  disabledModels: string[] | null; // Array of "provider:modelId" strings
}

export interface ConfiguredProvider {
  id: string;
  provider: string;
  label: string;
  configured: boolean;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
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
