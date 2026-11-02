/**
 * A fire with nowhere to go: the agent runs on its own.
 *
 * `deliver: "none"` is the automation that replaces an agent job. The script's
 * verdict (or the bare schedule, when there is no script) starts a fresh agent
 * with the watcher's tools and the wake message, and no chat is written to. What
 * the user hears about has to come from the tools the agent calls itself, so the
 * run's answer and its usage are returned for the tick log.
 */

import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { prisma } from "@/lib/db";
import { buildModelRuntime } from "@/lib/pi/models";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { createSaaleAgentSession } from "@/lib/pi/agent-session";
import { createSandboxScopedTools } from "@/lib/pi/session";
import { resolveTools } from "@/lib/pi/tool-registry";
import { loadToolExposure } from "@/lib/pi/tool-exposure";
import { DEFAULT_TOOL_CONFIG, type ToolConfig } from "@/lib/pi/tool-categories";
import {
  createSystemPromptLoader,
  startSessionExtensions,
  TOOLS_PROMPT,
} from "@/lib/pi/processing-state";
import { thinkingLevelOption } from "@/lib/pi/thinking-levels";
import { createAgentIdleTimeout } from "@/lib/pi/agent-idle-timeout";

/** How long a run may sit silent before it is treated as stalled. */
const WAKE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** The instruction an unattended run starts from. */
const SYSTEM_PROMPT = [
  "You are an automation: a prompt that runs on a schedule with nobody watching.",
  "Work through what it asks for. Nothing you write reaches the user on its own, so anything they need to hear has to be sent with your tools.",
  TOOLS_PROMPT,
].join("\n\n");

/** What a standalone run produced. */
export interface StandaloneWakeResult {
  /** What the agent said, for the tick log. */
  answer: string;
  /** The tools it called. how a run with no chat delivered anything. */
  toolNames: string[];
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

/** The text blocks of one message. */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** The tools a standalone run may reach: the user's own selection, scoped to the automation. */
async function loadAutomationTools(userId: string, scopeId: string) {
  const settings = await prisma.appSettings.findUnique({
    where: { userId },
    select: { defaultToolConfig: true },
  });

  const toolConfig = {
    ...DEFAULT_TOOL_CONFIG,
    ...((settings?.defaultToolConfig as Record<string, boolean>) ?? {}),
  } as Required<ToolConfig>;

  return resolveTools(userId, scopeId, toolConfig, {
    createSandboxScopedTools,
    exposure: await loadToolExposure(userId),
  });
}

/**
 * Run one wake with no chat.
 *
 * Never leaves a session behind: the run is disposed on every exit path, and an
 * aborted or failed run throws so the tick records a blocked fire and keeps the
 * script's ledger where it was.
 */
export async function runStandaloneWake(options: {
  userId: string;
  /** The watcher that fired, for its model, thinking level and tool scope. */
  watcher: {
    id: string;
    modelId: string | null;
    thinkingLevel: string;
  };
  /** What the tools act as: the chat that asked for the automation, or the automation itself. */
  scopeId: string;
  message: string;
}): Promise<StandaloneWakeResult> {
  const { userId, watcher, scopeId, message } = options;

  const modelInfo = await resolveModelForPurpose(userId, "jobs", watcher.modelId);
  if (!modelInfo) {
    throw new Error("No AI model configured for this automation. Pick one in Settings → AI.");
  }

  const { modelRuntime } = await buildModelRuntime(userId);
  const model = modelRuntime.getModel(modelInfo.provider, modelInfo.name);
  const customTools = await loadAutomationTools(userId, scopeId);

  const { session } = await createSaaleAgentSession(userId, {
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    noTools: "builtin",
    ...(model ? { model } : {}),
    customTools,
    resourceLoader: await createSystemPromptLoader(SYSTEM_PROMPT, process.cwd()),
    ...thinkingLevelOption(watcher.thinkingLevel),
  });

  await startSessionExtensions(session);

  const answers: string[] = [];
  const toolNames = new Set<string>();

  return new Promise<StandaloneWakeResult>((resolve, reject) => {
    let settled = false;

    const stop = () => {
      idleTimeout.clear();
      unsubscribe();
      session.dispose();
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      stop();

      const stats = session.getSessionStats();
      resolve({
        answer: answers.filter((part) => part.trim()).join("\n\n"),
        toolNames: [...toolNames],
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cost: stats.cost,
      });
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      stop();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const idleTimeout = createAgentIdleTimeout({
      session,
      timeoutMs: WAKE_IDLE_TIMEOUT_MS,
      label: `automation:${watcher.id}`,
      onTimeout: () => {
        void session.abort().catch((err) => {
          console.error(`[automation:${watcher.id}] Failed to abort a stalled run:`, err);
        });
        fail(new Error("The run stalled: nothing happened for 10 minutes"));
      },
    });

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "turn_end": {
          if (event.message.role === "assistant") {
            const text = extractText((event.message as { content: unknown }).content);
            if (text.trim()) answers.push(text);
          }
          break;
        }
        case "tool_execution_end": {
          toolNames.add(event.toolName);
          break;
        }
        // Emitted after retries and post-run compaction, so it is the one point
        // the run is genuinely over.
        case "agent_settled": {
          settle();
          break;
        }
        case "auto_retry_end": {
          if (!event.success) fail(new Error(event.finalError ?? "Agent retry failed"));
          break;
        }
      }
    });

    session.prompt(message, { expandPromptTemplates: false }).catch((err: unknown) => fail(err));
  });
}
