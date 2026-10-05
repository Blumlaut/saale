import fs from "fs/promises";
import {
  createAgentSession,
  SessionManager,
  type CreateAgentSessionResult,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createAgentResourceLoader, startSessionExtensions } from "./processing-state";
import { createSessionSettings } from "./settings";
import { buildSessionDeps, type ToolConfig } from "./session";
import { thinkingLevelOption } from "./thinking-levels";
import type { ApprovalRequest } from "./tool-approval-gate";

/**
 * Create a Pi agent session with file-based persistence.
 *
 * Uses SessionManager.continueRecent() which:
 * - Scans sessionDir for existing .jsonl files
 * - If found → loads full session history from disk (including compaction state)
 * - If not found → creates a fresh session with a new JSONL file
 *
 * The session file survives process restarts (stored on uploads_data volume).
 *
 * @param options.userId - The authenticated user's ID
 * @param options.sessionId - ChatSession.id from DB (used for tool resolution and directory naming)
 * @param options.sessionDir - Directory for Pi's JSONL session files (pi_sessions/{userId}/{sessionId}/)
 * @param options.customTools - Additional custom tools to register
 * @param options.toolConfig - Tool category configuration
 * @param options.modelProvider - Model provider (e.g., "anthropic")
 * @param options.modelName - Model name (e.g., "claude-sonnet-4-5")
 * @param options.thinkingLevel - Thinking level for the model
 * @param options.wrapTool - Optional wrapper applied to every resolved tool (e.g. approval gate)
 * @param options.systemPrompt - Custom system prompt (served via resource loader)
 * @param options.emitApprovalRequest - Approval channel for MCP tool calls
 * @param options.toolPolicies - Per-tool approval policies (MCP tools are gated by them)
 * @param options.mcp - Connect the user's MCP servers for this session
 */
export async function createPersistentSession(options: {
  userId: string;
  sessionId: string; // ChatSession.id from DB
  sessionDir: string; // pi_sessions/{userId}/{sessionId}/
  customTools: ToolDefinition[];
  toolConfig?: ToolConfig;
  modelProvider?: string;
  modelName?: string;
  thinkingLevel?: string;
  /** Optional wrapper applied to every resolved tool (e.g. approval gate). */
  wrapTool?: (tool: ToolDefinition) => ToolDefinition;
  /** System prompt served through the resource loader. */
  systemPrompt: string;
  /** Approval channel for MCP tool calls; without it MCP servers are not connected. */
  emitApprovalRequest?: ((request: ApprovalRequest) => void) | undefined;
  toolPolicies?: Record<string, string> | null | undefined;
  mcp?: boolean;
}): Promise<CreateAgentSessionResult> {
  // Ensure session directory exists
  await fs.mkdir(options.sessionDir, { recursive: true });

  // Build shared dependencies (model runtime, tools, model resolution)
  const { modelRuntime, allCustomTools, model } = await buildSessionDeps({
    userId: options.userId,
    sessionId: options.sessionId,
    customTools: options.customTools,
    toolConfig: options.toolConfig,
    modelProvider: options.modelProvider,
    modelName: options.modelName,
    ...(options.wrapTool ? { wrapTool: options.wrapTool } : {}),
  });

  // Create or resume file-based SessionManager.
  //
  // SessionManager.continueRecent() (session-manager.js:1354-1362):
  //   1. Calls findMostRecentSession() to scan sessionDir for .jsonl files
  //   2. If found → new SessionManager(cwd, dir, filePath, true) → setSessionFile()
  //      → loadEntriesFromFile() → builds full in-memory index from disk
  //   3. If not found → new SessionManager(cwd, dir, undefined, true) → newSession()
  //      → creates fresh session header and generates new file path
  //
  // Since each chat session has its own directory (pi_sessions/{userId}/{id}/)
  // with exactly one JSONL file, continueRecent() always finds the right file.
  const sessionManager = SessionManager.continueRecent(
    options.sessionDir, // cwd — stored in session header
    options.sessionDir, // sessionDir — where JSONL files are written
  );

  const result = await createAgentSession({
    sessionManager, // File-based — entries persist to JSONL
    modelRuntime,
    settingsManager: createSessionSettings(),
    noTools: "builtin",
    ...(model ? { model } : {}),
    customTools: allCustomTools,
    resourceLoader: await createAgentResourceLoader({
      prompt: options.systemPrompt,
      cwd: options.sessionDir,
      ...(options.mcp && options.emitApprovalRequest
        ? {
            mcp: {
              userId: options.userId,
              sessionId: options.sessionId,
              toolPolicies: options.toolPolicies,
              emitApprovalRequest: options.emitApprovalRequest,
            },
          }
        : {}),
    }),
    // Omitted when unset ("default") so Pi keeps the level recorded in the
    // session file, or its own default.
    ...thinkingLevelOption(options.thinkingLevel),
  });

  // Extensions connect on `session_start` — the user's MCP servers among them.
  await startSessionExtensions(result.session);

  return result;
}
