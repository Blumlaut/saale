/** The shape every agent job definition response uses. */

export interface AgentDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  systemPrompt: string | null;
  toolConfig: unknown;
  modelId: string | null;
  thinkingLevel: string;
  outputChannel: string | null;
  outputChannelId: string | null;
  cronExpression: string | null;
  runAt: Date | null;
  lastRunAt: Date | null;
  enabled: boolean;
  systemManaged: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A definition with dates as ISO strings, as the app reads it. */
export function serializeAgentDefinition(definition: AgentDefinitionRow) {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    prompt: definition.prompt,
    systemPrompt: definition.systemPrompt,
    toolConfig: definition.toolConfig as Record<string, boolean> | null,
    modelId: definition.modelId,
    thinkingLevel: definition.thinkingLevel,
    outputChannel: definition.outputChannel,
    outputChannelId: definition.outputChannelId,
    cronExpression: definition.cronExpression,
    runAt: definition.runAt?.toISOString() ?? null,
    lastRunAt: definition.lastRunAt?.toISOString(),
    enabled: definition.enabled,
    systemManaged: definition.systemManaged,
    createdAt: definition.createdAt.toISOString(),
    updatedAt: definition.updatedAt.toISOString(),
  };
}
