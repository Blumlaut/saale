import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { getSessionDir } from "./agent-pool";
import { resolveModelForPurpose } from "./model-resolution";
import { createPersistentSession } from "./persistent-session";
import { buildAgentSystemPrompt } from "./processing-state";
import { listSandboxEnvNames } from "@/lib/sandbox/env";
import type { ApprovalRequest } from "./tool-approval-gate";
import type { ToolConfig, ToolExposureConfig } from "./tool-categories";
import { normalizeToolExposure } from "./tool-exposure";

/**
 * The single place a chat session's Pi agent is created.
 *
 * Every entry point that can bring a chat's agent into the pool must build it
 * identically. most importantly the tool approval gate, which is applied to
 * the tool definitions at creation time and is the ONLY thing that enforces a
 * user's per-tool policies. A session created without it runs tools
 * unapproved for the rest of the pool entry's life (see `wrapTool`).
 */

/** AppSettings fields a chat agent session is built from. */
export interface ChatUserSettings {
  /** Custom instructions appended to the Saale system prompt. */
  customInstructions: string | null;
  /** Per-tool approval policies, keyed by tool name. */
  toolPolicies: Record<string, string> | null;
  /** Per-category exposure. how each category's tools reach the model. */
  toolExposure: ToolExposureConfig | null;
}

/** Load the user settings that shape a chat agent session. */
export async function loadChatUserSettings(userId: string): Promise<ChatUserSettings> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { agentCustomInstructions: true, toolPolicies: true, toolExposure: true },
  });
  return {
    customInstructions: settings?.agentCustomInstructions ?? null,
    toolPolicies: (settings?.toolPolicies as Record<string, string> | null) ?? null,
    toolExposure: normalizeToolExposure(settings?.toolExposure),
  };
}

/** The configuration a chat agent session is built from (ChatSession row). */
export interface ChatSessionModelConfig {
  modelProvider: string | null;
  modelName: string | null;
  thinkingLevel: string | null;
  toolConfig: unknown;
}

/** The chat's model, falling back to the user's default chat model. */
export async function resolveChatModel(
  userId: string,
  chatSession: Pick<ChatSessionModelConfig, "modelProvider" | "modelName">,
): Promise<{ provider: string; name: string } | undefined> {
  if (chatSession.modelProvider && chatSession.modelName) {
    return { provider: chatSession.modelProvider, name: chatSession.modelName };
  }
  const resolved = await resolveModelForPurpose(userId, "chat", undefined);
  return resolved ? { provider: resolved.provider, name: resolved.name } : undefined;
}

export interface CreateChatAgentSessionOptions {
  userId: string;
  /** ChatSession.id from the DB. */
  sessionId: string;
  chatSession: ChatSessionModelConfig;
  /** Resolved model; falls back to the user's default chat model when omitted. */
  model?: { provider: string; name: string } | undefined;
  customInstructions: string | null;
  /** Per-tool approval policies (`AppSettings.toolPolicies`). */
  toolPolicies: Record<string, string> | null | undefined;
  /** Per-category exposure (`AppSettings.toolExposure`). */
  toolExposure: ToolExposureConfig | null | undefined;
  /**
   * Wraps every resolved tool. Always pass the approval gate. tools resolved
   * without it execute without the user's approval policy.
   */
  wrapTool: (tool: ToolDefinition) => ToolDefinition;
  /**
   * Approval channel for MCP tool calls. MCP tools are registered by Pi's MCP
   * extension after the session exists, so they never pass through `wrapTool`;
   * their gate publishes through this instead (`lib/pi/mcp-tool-policy.ts`).
   */
  emitApprovalRequest: (request: ApprovalRequest) => void;
}

/**
 * Create (or resume) the Pi agent session backing a chat session.
 *
 * The agent's transcript lives in the chat's own directory, so a session that
 * was evicted from the pool resumes its full history. including compaction
 * state. from the JSONL file.
 */
export async function createChatAgentSession(
  options: CreateChatAgentSessionOptions,
): Promise<{ session: AgentSession; sessionDir: string }> {
  const { userId, sessionId, chatSession } = options;
  const sessionDir = getSessionDir(userId, sessionId);

  const model = options.model ?? (await resolveChatModel(userId, chatSession));
  const toolConfig: ToolConfig = chatSession.toolConfig
    ? { ...(chatSession.toolConfig as ToolConfig) }
    : {};

  const result = await createPersistentSession({
    userId,
    sessionId,
    sessionDir,
    customTools: [],
    toolConfig,
    toolExposure: options.toolExposure,
    ...(model ? { modelProvider: model.provider, modelName: model.name } : {}),
    ...(chatSession.thinkingLevel ? { thinkingLevel: chatSession.thinkingLevel } : {}),
    wrapTool: options.wrapTool,
    emitApprovalRequest: options.emitApprovalRequest,
    toolPolicies: options.toolPolicies,
    mcp: true,
    systemPrompt: buildAgentSystemPrompt({
      customInstructions: options.customInstructions,
      toolConfig,
      sandboxEnvNames: await listSandboxEnvNames(userId),
    }),
  });

  return { session: result.session, sessionDir };
}
