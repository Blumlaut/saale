/**
 * Server-side orchestration for one chat turn.
 *
 * A chat's agent is prompted from two places: the SSE stream route (a message
 * the user submitted) and the `chat_respond` tool (a message an agent posted
 * into another chat). Both must build, pool, register and persist the agent
 * identically. a step missing on one path shows up as a run that never
 * reaches the DB, a client that never settles, or a generation that Stop and
 * the stream supervisor cannot see.
 *
 * The stream route keeps the parts that are about its connection (SSE
 * lifecycle, queue drain, rewinds, image loading); everything that defines
 * "a run" lives here.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentIdleTimeout, DEFAULT_AGENT_IDLE_TIMEOUT_MS } from "@/lib/pi/agent-idle-timeout";
import type { ImageContent } from "@/lib/pi/message-replay";
import { createAndPool, get as getPoolEntry, getPoolKey } from "@/lib/pi/agent-pool";
import {
  createChatAgentSession,
  loadChatUserSettings,
  type ChatSessionModelConfig,
} from "@/lib/pi/chat-session-factory";
import { createChatApprovalEmitter } from "@/lib/pi/tool-approval-gate";
import { ensureWorktree } from "@/lib/coder/worktrees";
import {
  clearAgentBuilding,
  markAgentBuilding,
  registerActiveSession,
  unregisterActiveSession,
} from "@/lib/redis";
import { publishSessionEvent, resetSessionEvents } from "@/lib/pi/session-events";
import { waitForPersistenceTeardown, wireSessionPersistence } from "@/lib/pi/session-persistence";
import { submitDeferringToCompaction } from "@/lib/pi/compaction-defer";
import { clearActiveToolState } from "@/lib/chat/active-tool-state";
import { notifyChatFinished } from "@/lib/notifications/chat-finished";

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
 * approval channel are attached. a second construction path that forgot one
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

  // A build can take minutes (checkout, fetch, setup script) and no run is
  // registered for the chat while it happens. Hold the chat busy for it, or a
  // message sent meanwhile claims a prompt this process cannot deliver.
  await markAgentBuilding(sessionId);
  let entry: PooledChatSession;
  try {
    entry = await createAndPool(poolKey, async () => {
      options.log?.("pool", "miss. creating new agent");

      // Only on a miss: the settings and the gate they shape are baked into the
      // session, which is exactly why this is the one construction path.
      const userSettings = await loadChatUserSettings(userId);
      const emitApprovalRequest = createChatApprovalEmitter(sessionId);

      // A coder chat runs in its worktree and nowhere else. Building it here is
      // what keeps every entry point (browser, telegram, respond-in-chat) off the
      // repo checkout, and a failure rejects the pool creation instead of
      // falling back to the workspace.
      const worktree = options.chatSession.projectId
        ? await ensureWorktree(userId, sessionId)
        : null;

      return createChatAgentSession({
        userId,
        sessionId,
        chatSession: options.chatSession,
        ...(options.model ? { model: options.model } : {}),
        customInstructions: userSettings.customInstructions,
        coderCustomInstructions: userSettings.coderCustomInstructions,
        toolPolicies: userSettings.toolPolicies,
        toolExposure: userSettings.toolExposure,
        ...(worktree ? { workspaceCwd: worktree.path, checkoutMode: worktree.mode } : {}),
        emitApprovalRequest,
      });
    });
  } finally {
    await clearAgentBuilding(sessionId);
  }

  return { entry, existedAlready: existing !== undefined };
}

/**
 * Claim a chat's agent for one run: publish the generation as active (so other
 * connections observe instead of prompting, and Stop can find it), clear the
 * previous run's buffered events, and wire DB persistence + stream publishing.
 *
 * The caller must have set `entry.promptInFlight` first. that is the
 * same-process double-prompt guard.
 */
export async function beginChatRun(options: {
  userId: string;
  sessionId: string;
  session: AgentSession;
}): Promise<void> {
  const { userId, sessionId, session } = options;

  // This run starts with no tool in flight. A previous run that died left its
  // tool bookkeeping in the DB. clearing it keeps a refresh from showing a
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
 * (`agent_settled`. after any error retry, auto-compaction, or queued
 * continuation).
 *
 * Uses `session.prompt()`. the same path the Pi TUI uses. NOT
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

  // A run can go completely silent. a provider whose stream never closes after
  // the server it was talking to went away, or a tool that never returns. and
  // `session.prompt()` would then never settle. `promptInFlight` stays set, the
  // send queue sees a busy session, and the chat can never send again, which is
  // exactly the state Stop is supposed to clear. Silence is the evidence: every
  // session event resets the window, so a run that is streaming, thinking or
  // running tools is never touched.
  let rejectStall: (err: Error) => void = () => {};
  const stalled = new Promise<never>((_resolve, reject) => {
    rejectStall = reject;
  });
  const idleTimeout = createAgentIdleTimeout({
    session: entry.session,
    timeoutMs: DEFAULT_AGENT_IDLE_TIMEOUT_MS,
    label: `chat:${options.sessionId}`,
    onTimeout: () => {
      // Not awaited: a session that will not settle must not hold the timeout.
      void Promise.resolve(entry.session.abort()).catch((err) => {
        console.error(`Failed to abort the stalled chat run for ${options.sessionId}:`, err);
      });
      rejectStall(
        new Error(
          `The generation stalled (no activity for ${Math.round(DEFAULT_AGENT_IDLE_TIMEOUT_MS / 60_000)} minutes).`,
        ),
      );
    },
  });

  try {
    const images = options.images ?? [];
    await Promise.race([
      submitDeferringToCompaction(entry.session, () =>
        images.length > 0
          ? entry.session.prompt(options.content, { images })
          : entry.session.prompt(options.content),
      ),
      stalled,
    ]);
    entry.promptInFlight = false;
    options.log?.("prompt", "session.prompt() settled");
    // Reaches a device whose user has walked away from the conversation. Not
    // awaited: the run is over either way, and a slow push service must not
    // hold the stream open.
    void notifyChatFinished({ userId: options.userId, sessionId: options.sessionId });
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
  } finally {
    idleTimeout.clear();
  }
}
