import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { getSessionDir } from "./agent-pool";
import { resolveModelForPurpose } from "./model-resolution";
import { createPersistentSession } from "./persistent-session";
import { buildAgentSystemPrompt } from "./processing-state";
import { buildCoderSystemPrompt } from "./coder-prompt";
import { resolveCoderToolConfig } from "./coder-tools";
import { listSandboxEnvNames } from "@/lib/sandbox/env";
import { previewConfig } from "@/lib/preview/config";
import type { ApprovalRequest } from "./tool-approval-gate";
import { hasCodemodeCategory, type ToolConfig, type ToolExposureConfig } from "./tool-categories";
import { normalizeToolExposure } from "./tool-exposure";
import { loadUserMcpServers } from "@/lib/mcp/servers";
import type { ChatMode } from "@/lib/coder/checkout";

/**
 * The single place a chat session's Pi agent is created.
 *
 * Every entry point that can bring a chat's agent into the pool must build it
 * identically. most importantly the approval channel, which the session's gate
 * publishes through and which is fixed at creation.
 */

/** AppSettings fields a chat agent session is built from. */
export interface ChatUserSettings {
  /** Custom instructions appended to the Saale system prompt. */
  customInstructions: string | null;
  /** Custom instructions for a coder chat, in place of `customInstructions`. */
  coderCustomInstructions: string | null;
  /** Per-tool approval policies, keyed by tool name. */
  toolPolicies: Record<string, string> | null;
  /** Per-category exposure. how each category's tools reach the model. */
  toolExposure: ToolExposureConfig | null;
}

/** Load the user settings that shape a chat agent session. */
export async function loadChatUserSettings(userId: string): Promise<ChatUserSettings> {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: {
      agentCustomInstructions: true,
      coderCustomInstructions: true,
      toolPolicies: true,
      toolExposure: true,
    },
  });
  return {
    customInstructions: settings?.agentCustomInstructions ?? null,
    coderCustomInstructions: settings?.coderCustomInstructions ?? null,
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
  /** Set on a coder chat, which runs in its project's worktree. */
  projectId: string | null;
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
  /**
   * Custom instructions for a coder session (`projectId` set), used instead of
   * `customInstructions`: guidance about a worktree is not guidance about a
   * conversation.
   */
  coderCustomInstructions?: string | null;
  /** Per-tool approval policies (`AppSettings.toolPolicies`). */
  toolPolicies: Record<string, string> | null | undefined;
  /** Per-category exposure (`AppSettings.toolExposure`). */
  toolExposure: ToolExposureConfig | null | undefined;
  /**
   * Approval channel for the session's tool calls. Every call goes through the
   * gate this feeds (`lib/pi/tool-approval-extension.ts`).
   */
  emitApprovalRequest: (request: ApprovalRequest) => void;
  /**
   * Workspace-relative directory the agent works in. A coder chat passes its
   * worktree; every other chat leaves it unset and gets the workspace root.
   */
  workspaceCwd?: string | undefined;
  /** Which checkout `workspaceCwd` is, for the prompt a coder chat starts with. */
  checkoutMode?: ChatMode | undefined;
}

/** The prompt a session starts with: the coder one for a project chat. */
async function buildSessionPrompt(options: {
  userId: string;
  projectId: string | null;
  customInstructions: string | null;
  coderCustomInstructions: string | null | undefined;
  toolConfig: ToolConfig;
  toolExposure: ToolExposureConfig | null | undefined;
  checkoutMode?: ChatMode | undefined;
}): Promise<string> {
  const sandboxEnvNames = await listSandboxEnvNames(options.userId);
  // MCP tools are codemode's by default, so a user with servers needs the hint
  // even when every category they enabled is declared in full.
  const mcpServers = await loadUserMcpServers(options.userId).catch((err: unknown) => {
    console.error(`Failed to load the MCP servers of ${options.userId} for its prompt:`, err);
    return { entries: [] };
  });
  const shared = {
    // A coder chat carries its own instructions: "answer in German" suits a
    // conversation but is not what a coding session needs to be told.
    customInstructions: options.projectId
      ? options.coderCustomInstructions
      : options.customInstructions,
    toolConfig: options.toolConfig,
    sandboxEnvNames,
    previewDomain: previewConfig().domain,
    codemodeTools:
      mcpServers.entries.length > 0 ||
      hasCodemodeCategory(options.toolConfig, options.toolExposure),
  };
  return options.projectId
    ? buildCoderSystemPrompt({ ...shared, checkout: options.checkoutMode })
    : buildAgentSystemPrompt(shared);
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
  // A coder chat follows the coder defaults for a category its stored config
  // does not name. A chat keeps the registry defaults it always had.
  const stored = chatSession.toolConfig as ToolConfig | null;
  const toolConfig: ToolConfig = chatSession.projectId
    ? (resolveCoderToolConfig(stored as Record<string, unknown> | null) as ToolConfig)
    : stored
      ? { ...stored }
      : {};

  const result = await createPersistentSession({
    userId,
    sessionId,
    sessionDir,
    ...(options.workspaceCwd ? { workspaceCwd: options.workspaceCwd } : {}),
    customTools: [],
    toolConfig,
    toolExposure: options.toolExposure,
    ...(model ? { modelProvider: model.provider, modelName: model.name } : {}),
    ...(chatSession.thinkingLevel ? { thinkingLevel: chatSession.thinkingLevel } : {}),
    emitApprovalRequest: options.emitApprovalRequest,
    toolPolicies: options.toolPolicies,
    mcp: true,
    systemPrompt: await buildSessionPrompt({
      userId,
      projectId: chatSession.projectId,
      customInstructions: options.customInstructions,
      coderCustomInstructions: options.coderCustomInstructions,
      toolConfig,
      toolExposure: options.toolExposure,
      ...(options.checkoutMode ? { checkoutMode: options.checkoutMode } : {}),
    }),
  });

  return { session: result.session, sessionDir };
}
