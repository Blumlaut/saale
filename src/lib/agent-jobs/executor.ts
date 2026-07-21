import {
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { buildModelRegistry } from "@/lib/pi/models";
import { resolveTools } from "@/lib/pi/tool-registry";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Optional output handler for routing agent responses to external channels. */
export interface AgentOutput {
  /** Send a message to the output channel. Called for each assistant turn. */
  send(content: string, meta?: { toolCalls?: unknown[] }): void;
  /** Optional: signal that the agent is thinking/working. */
  typing?(): void;
}

interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string | undefined;
  isError?: boolean | undefined;
}

interface RunState {
  /** Collected tool calls across all turns */
  toolCalls: Map<string, ToolCallRecord>;
  /** Current turn's text content */
  currentText: string;
  /** Current turn's thinking content */
  currentThinking: string;
  /** Turn index (0-based) */
  turnIndex: number;
  /** Root assistant message ID (first turn's DB id, used as parentMessageId) */
  rootMessageId: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract text blocks from a message content array. */
function extractText(content: unknown[]): string {
  return content
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
    )
    .map((c) => (c.text as string) || "")
    .join("");
}

/** Extract thinking content from a message content array. */
function extractThinking(content: unknown[]): string | null {
  const block = content.find(
    (c): c is Record<string, unknown> =>
      typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "thinking",
  );
  if (!block || !block.thinking) return null;
  return block.thinking as string;
}

/** Extract tool call blocks from a message content array. */
function extractToolCalls(content: unknown[]): Record<string, unknown>[] {
  return content.filter(
    (c): c is Record<string, unknown> =>
      typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "toolCall",
  );
}

/** Normalize a tool result to a string for consistent storage. */
function normalizeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.content)) {
      return obj.content
        .filter(
          (c: unknown): c is Record<string, unknown> =>
            typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
        )
        .map((c) => (c.text as string) || "")
        .join("");
    }
    return JSON.stringify(obj);
  }
  return String(result ?? "");
}

/** Save an assistant message to the run. */
async function saveAssistantMessage(
  runId: string,
  content: string,
  thinking: string | null,
  toolCalls: ToolCallRecord[],
  parentMessageId: string | null,
): Promise<string> {
  const msg = await prisma.agentRunMessage.create({
    data: {
      runId,
      role: "assistant",
      content,
      thinking: thinking || null,
      toolCalls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      parentMessageId: parentMessageId || null,
    },
  });
  return msg.id;
}

// ─── Core Executor ───────────────────────────────────────────────────────────

/**
 * Execute an agent job run.
 *
 * Creates an in-memory agent session, configures tools and model,
 * subscribes to events to capture the full conversation, and saves
 * messages to the database as they arrive.
 *
 * @param runId - The AgentRun.id to update
 * @param definition - The AgentDefinition record (prompt, systemPrompt, toolConfig, etc.)
 * @param userId - The user ID (for model registry and tool scoping)
 * @param output - Optional output handler for routing responses to external channels
 * @returns Final stats (tokens, cost) for updating the run record
 */
export async function executeAgentRun(
  runId: string,
  definition: {
    prompt: string;
    systemPrompt?: string | null;
    toolConfig?: Record<string, boolean> | null;
    modelId?: string | null;
    thinkingLevel?: string;
  },
  userId: string,
  output?: AgentOutput,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  cost: number;
}> {
  // Resolve model
  let modelProvider: string | undefined;
  let modelName: string | undefined;

  if (definition.modelId) {
    const [provider, ...nameParts] = definition.modelId.split(":");
    modelProvider = provider;
    modelName = nameParts.join(":");
  } else {
    const settings = await prisma.appSettings.findUnique({
      where: { userId },
      select: { defaultModelProvider: true, defaultModelName: true },
    });
    if (settings?.defaultModelProvider && settings?.defaultModelName) {
      modelProvider = settings.defaultModelProvider;
      modelName = settings.defaultModelName;
    }
  }

  if (!modelProvider || !modelName) {
    throw new Error(
      "No AI model configured. Set a default model in Settings or override on the job definition.",
    );
  }

  // Build model registry and tools
  const { modelRegistry, authStorage } = await buildModelRegistry(userId);
  const model = modelRegistry.find(modelProvider, modelName);

  // Merge tool config with defaults — terminal is always disabled for agent jobs
  const rawToolConfig = (definition.toolConfig as Record<string, boolean>) ?? {};
  const resolvedToolConfig = {
    ...DEFAULT_TOOL_CONFIG,
    ...rawToolConfig,
    terminal: false,
  } as Required<ToolConfig>;

  const allCustomTools = await resolveTools(userId, runId, resolvedToolConfig, {
    createTerminalScopedTools: () => {
      throw new Error("Terminal tools are not available for agent jobs.");
    },
  });

  // Create agent session
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    noTools: "builtin",
    ...(model ? { model } : {}),
    customTools: allCustomTools,
    thinkingLevel:
      (definition.thinkingLevel as "off" | "minimal" | "low" | "medium" | "high" | "xhigh") ??
      "off",
  });

  // Set system prompt
  session.agent.state.systemPrompt =
    definition.systemPrompt ??
    `You are an AI assistant executing an automated job. Be concise and focus on completing the task effectively.`;

  // Run state
  const state: RunState = {
    toolCalls: new Map(),
    currentText: "",
    currentThinking: "",
    turnIndex: 0,
    rootMessageId: null,
  };

  // Save the user prompt as the first message
  await prisma.agentRunMessage.create({
    data: {
      runId,
      role: "user",
      content: definition.prompt,
    },
  });

  let timerId: ReturnType<typeof setTimeout>;
  const TIMEOUT_MS = 10 * 60_000; // 10 minutes

  return new Promise((resolve, reject) => {
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      try {
        handleAgentEvent(event, runId, state, output);
      } catch (err) {
        console.error(`[agent-job:${runId}] Event handler error:`, err);
      }

      if (event.type === "agent_end") {
        clearTimeout(timerId);
        unsubscribe();

        try {
          const stats = session.getSessionStats();
          resolve({
            inputTokens: stats.tokens.input,
            outputTokens: stats.tokens.output,
            cost: stats.cost,
          });
        } catch (err) {
          console.error(`[agent-job:${runId}] Failed to get session stats:`, err);
          resolve({ inputTokens: 0, outputTokens: 0, cost: 0 });
        }
      }

      if (event.type === "auto_retry_end" && !event.success) {
        clearTimeout(timerId);
        unsubscribe();
        reject(new Error(event.finalError ?? "Agent retry failed"));
      }
    });

    // Timeout guard
    timerId = setTimeout(() => {
      unsubscribe();
      session.abort().catch((err) => {
        console.error(`[agent-job:${runId}] Failed to abort on timeout:`, err);
      });
      reject(new Error("Agent job timed out (10min)"));
    }, TIMEOUT_MS);

    // Send the prompt
    session.agent.prompt(definition.prompt).catch((err) => {
      clearTimeout(timerId);
      unsubscribe();
      reject(err);
    });
  });
}

/**
 * Handle a single agent event and persist relevant data.
 */
async function handleAgentEvent(
  event: AgentSessionEvent,
  runId: string,
  state: RunState,
  output?: AgentOutput,
): Promise<void> {
  switch (event.type) {
    case "message_update": {
      if (event.message.role !== "assistant") return;
      const content = (event.message as { content: unknown[] }).content;

      state.currentText = extractText(content);
      state.currentThinking = extractThinking(content) || "";

      break;
    }

    case "tool_execution_start": {
      state.toolCalls.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
      });

      // Signal typing when tools start executing
      output?.typing?.();
      break;
    }

    case "tool_execution_end": {
      const existing = state.toolCalls.get(event.toolCallId);
      if (existing) {
        existing.result = normalizeToolResult(event.result);
        existing.isError = event.isError;
      }
      break;
    }

    case "turn_end": {
      const assistantMsg =
        event.message.role === "assistant" ? (event.message as { content: unknown[] }) : null;
      const toolCallBlocks = assistantMsg ? extractToolCalls(assistantMsg.content) : [];

      const turnToolCalls = toolCallBlocks.map((tc: Record<string, unknown>) => {
        const result = state.toolCalls.get(tc.id as string);
        return {
          id: tc.id as string,
          name: tc.name as string,
          args: tc.arguments as Record<string, unknown>,
          result: result?.result,
          isError: result?.isError,
        };
      });

      const msgId = await saveAssistantMessage(
        runId,
        state.currentText,
        state.currentThinking || null,
        turnToolCalls,
        state.rootMessageId,
      );

      if (!state.rootMessageId) {
        state.rootMessageId = msgId;
      }

      // Route output to external channel
      if (output && state.currentText.trim()) {
        const meta: { toolCalls?: unknown[] } = {};
        if (turnToolCalls.length > 0) {
          meta.toolCalls = turnToolCalls;
        }
        output.send(state.currentText, meta);
      }

      state.turnIndex++;
      state.currentText = "";
      state.currentThinking = "";
      break;
    }
  }
}
