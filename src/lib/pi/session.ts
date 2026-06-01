import {
  createAgentSession,
  type CreateAgentSessionResult,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Create an isolated Pi agent session for a user.
 * Each user gets their own in-memory session with custom tools scoped to their data.
 */
export async function createPiSession(options: {
  userId: string;
  customTools: ToolDefinition[];
  modelProvider?: string;
  modelName?: string;
  thinkingLevel?: string;
}): Promise<CreateAgentSessionResult> {
  const result = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    customTools: options.customTools,
    // Built-in tools (read, bash, edit, write) are enabled by default alongside custom tools
    thinkingLevel: (options.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh") ?? "off",
  });

  return result;
}
