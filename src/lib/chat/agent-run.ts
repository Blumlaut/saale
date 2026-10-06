/**
 * Server-side orchestration for one chat turn.
 *
 * A chat's agent is prompted from two places: the SSE stream route (a message
 * the user submitted) and the `chat_respond` tool (a message an agent posted
 * into another chat). Both must build, pool, register and persist the agent
 * identically — a step missing on one path shows up as a run that never
 * reaches the DB, a client that never settles, or a generation that Stop and
 * the stream supervisor cannot see.
 *
 * The stream route keeps the parts that are about its connection (SSE
 * lifecycle, queue drain, rewinds, image loading); everything that defines
 * "a run" lives here.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@/lib/pi/message-replay";
import { createAndPool, get as getPoolEntry, getPoolKey } from "@/lib/pi/agent-pool";
import {
  createChatAgentSession,
  loadChatUserSettings,
  type ChatSessionModelConfig,
} from "@/lib/pi/chat-session-factory";
import { createChatApprovalEmitter, createToolApprovalGate } from "@/lib/pi/tool-approval-gate";
import { registerActiveSession, unregisterActiveSession } from "@/lib/redis";
import { publishSessionEvent, resetSessionEvents } from "@/lib/pi/session-events";
import { waitForPersistenceTeardown, wireSessionPersistence } from "@/lib/pi/session-persistence";
import { submitDeferringToCompaction } from "@/lib/pi/compaction-defer";
import { clearActiveToolState } from "@/lib/chat/active-tool-state";

/** A pooled chat agent, as the agent pool hands it out. */
export type PooledChatSession = Awaited<ReturnType<typeof createAndPool>>;

/** Optional debug logger (the stream route prefixes it with the session id). */
export type ChatRunLog = (tag: string, ...args: unknown[]) => void;

/**
 * Ensure this process has the chat's agent, building it with the chat's own
 * settings when the pool is empty.
 *
 * Everything that shapes a session's tools is fixed at creation, so this is
 * also the only place the approval gate, the user's tool exposure and the MCP
 * approval channel are attached — a second construction path that forgot one
 * of them would silently run tools unapproved.
 */
export async function ensureChatAgent(options: {
  userId: string;
  sessionId: string;
  chatSession: ChatSessionModelConfig;
  /** Resolved model; the chat's own, or the user's default when omitted. */
  model?: { provider: string; name: string } | undefined;
  log?: ChatRunLog | undefined;
}): Promise<{ entry: PooledChatSession; existedAlready: boolean }> {
  const { userId, sessionId } = options;
  const poolKey = getPoolKey(userId, sessionId);
  const existing = getPoolEntry(poolKey);

  const entry = await createAndPool(poolKey, async () => {
    options.log?.("pool", "miss — creating new agent");

    // Only on a miss: the settings and the gates they shape are baked into the
    // session, which is exactly why this is the one construction path.
    const userSettings = await loadChatUserSettings(userId);
    const emitApprovalRequest = createChatApprovalEmitter(sessionId);
    const wrapTool = createToolApprovalGate({
      userId,
      sessionId,
      toolPolicies: userSettings.toolPolicies,
      emitApprovalRequest,
    });

    return createChatAgentSession({
      userId,
      sessionId,
      chatSession: options.chatSession,
      ...(options.model ? { model: options.model } : {}),
      customInstructions: userSettings.customInstructions,
      toolPolicies: userSettings.toolPolicies,
      toolExposure: userSettings.toolExposure,
      wrapTool,
      emitApprovalRequest,
    });
  });

  return { entry, existedAlready: existing !== undefined };
}

/**
 * Claim a chat's agent for one run: publish the generation as active (so other
 * connections observe instead of prompting, and Stop can find it), clear the
 * previous run's buffered events, and wire DB persistence + stream publishing.
 *
 * The caller must have set `entry.promptInFlight` first — that is the
 * same-process double-prompt guard.
 */
export async function beginChatRun(options: {
  userId: string;
  sessionId: string;
  session: AgentSession;
}): Promise<void> {
  const { userId, sessionId, session } = options;

  // This run starts with no tool in flight. A previous run that died left its
  // tool bookkeeping in the DB — clearing it keeps a refresh from showing a
  // phantom "Running …" until this run's first tool starts.
  await clearActiveToolState(sessionId, userId).catch((err) => {
    console.error(`Failed to clear stale active tool state for ${sessionId}:`, err);
  });

  await registerActiveSession(userId, sessionId);
  await resetSessionEvents(sessionId);

  // A previous run's tracker may still be publishing `done` and
  // unsubscribing. Wait for it: wiring a fresh tracker mid-teardown would
  // leave this run unpersisted (and double-publish its events).
  await waitForPersistenceTeardown(sessionId);
  wireSessionPersistence(sessionId, userId, session);
}

/**
 * Prompt a claimed agent and resolve when the run has fully settled
 * (`agent_settled` — after any error retry, auto-compaction, or queued
 * continuation).
 *
 * Uses `session.prompt()` — the same path the Pi TUI uses — NOT
 * `session.agent.prompt()`: the session wrapper runs the SDK's pre-prompt
 * compaction check and post-run processing. A manual /compact can still be
 * holding the session, so the prompt defers to it instead of failing.
 *
 * On failure the run is unregistered, the failure is published so connected
 * clients settle, and the buffer is cleared so a later connect can retry the
 * prompt instead of replaying the error table. Returns false.
 */
export async function dispatchChatRun(options: {
  userId: string;
  sessionId: string;
  entry: PooledChatSession;
  content: string;
  images?: ImageContent[] | undefined;
  /** Runs after a failed run was unregistered and published. */
  onRunFailed?: ((error: unknown) => void) | undefined;
  log?: ChatRunLog | undefined;
}): Promise<boolean> {
  const { entry } = options;
  options.log?.("prompt", "sending prompt");
  try {
    const images = options.images ?? [];
    await submitDeferringToCompaction(entry.session, () =>
      images.length > 0
        ? entry.session.prompt(options.content, { images })
        : entry.session.prompt(options.content),
    );
    entry.promptInFlight = false;
    options.log?.("prompt", "session.prompt() settled");
    return true;
  } catch (err) {
    entry.promptInFlight = false;
    entry.lastPromptedMessageId = null;
    console.error("session.prompt() failed:", err);
    unregisterActiveSession(options.userId, options.sessionId).catch(console.error);
    publishSessionEvent(options.sessionId, "error", {
      message: err instanceof Error ? err.message : String(err),
    }).catch(console.error);
    publishSessionEvent(options.sessionId, "done", {}).catch(console.error);
    resetSessionEvents(options.sessionId).catch(console.error);
    options.onRunFailed?.(err);
    return false;
  }
}
