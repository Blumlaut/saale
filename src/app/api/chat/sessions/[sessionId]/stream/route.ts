import type { NextRequest } from "next/server";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  claimPendingPrompt,
  getGenerationStartedAt,
  getPendingPrompt,
  isSessionActive,
  markGenerationStart,
  registerActiveSession,
  unregisterActiveSession,
} from "@/lib/redis";
import { type ToolConfig } from "@/lib/pi/session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { readImageAsBase64 } from "@/lib/image-attachment";
import type { ImageContent } from "@/lib/pi/message-replay";
import {
  createAndPool,
  get as getPoolEntry,
  getDispatcher,
  getPoolKey,
  getSessionDir,
} from "@/lib/pi/agent-pool";
import { createPersistentSession } from "@/lib/pi/persistent-session";
import { waitForPersistenceTeardown, wireSessionPersistence } from "@/lib/pi/session-persistence";
import { decideStreamAction, type DbMessage, type StreamAction } from "@/lib/pi/stream-logic";
import { getBufferedEvents } from "@/lib/pi/sse-buffer";
import { createSseHeartbeat, type SseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { publishSessionEvent, resetSessionEvents } from "@/lib/pi/session-events";
import { buildAgentSystemPrompt, lockSystemPrompt } from "@/lib/pi/processing-state";
import {
  claimNextQueuedMessage,
  countQueuedMessages,
  publishQueueUpdate,
  restoreQueuedMessage,
} from "@/lib/chat/queue";
import { drainSendQueue } from "@/lib/chat/drain-queue";
import {
  getPendingApprovals,
  wrapWithApprovalGate,
  type ApprovalRequest,
} from "@/lib/pi/tool-approval-gate";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Server-side SSE heartbeat interval.
 *
 * During a long tool call no stream events flow for minutes, so the
 * connection is completely idle. Idle-sniffing intermediaries (nginx
 * proxy_read_timeout, Cloudflare, load balancers) would kill it. A periodic
 * ping keeps the connection alive AND gives the client a liveness signal: its
 * watchdog force-reconnects when pings stop arriving.
 *
 * The ping is unbuffered and carries no `id:` line, so it never disturbs
 * Last-Event-ID reconnection or the replay dedupe.
 */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * GET /api/chat/sessions/:sessionId/stream — SSE streaming endpoint
 *
 * Pure observer: wires the HTTP response to the session's event stream
 * (Redis buffer replay + live pub/sub fan-out) and, when the last user
 * message is unanswered, claims and dispatches the prompt.
 *
 * No DB writes happen here — all persistence is handled by the session
 * event tracker (wired once per pooled session). Multiple clients may
 * connect concurrently (multiple tabs, reconnects, other processes); every
 * connection sees the same live stream.
 *
 * Uses Last-Event-ID for SSE-spec-compliant reconnection:
 * - Browser's EventSource automatically sends Last-Event-ID on reconnect
 * - The dispatcher replays buffered events after that ID, then forwards live
 *
 * Emits: turn_start, token, thinking, tool_start, tool_end, turn_end,
 * message_saved, token_usage, compaction_start, compaction_end, done, error,
 * tool_approval_request, queue_update
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;

  // ── Auth ──────────────────────────────────────────────────────────────
  const authResult = await requireChatSessionOwner(sessionId);
  if (!authResult.ok) return new Response("Unauthorized", { status: 401 });
  const chatSession = authResult.session;

  if (!chatSession) {
    return new Response("Not found", { status: 404 });
  }

  // ── User settings (system prompt + tool policies) ─────────────────────
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.userId },
    select: { agentCustomInstructions: true, toolPolicies: true },
  });

  const toolPolicies = userSettings?.toolPolicies as Record<
    string,
    "off" | "ask" | "allow" | "auto"
  > | null;
  const getPolicy = async (toolName: string): Promise<"off" | "ask" | "allow" | "auto"> =>
    toolPolicies?.[toolName] ?? getDefaultPolicy(toolName);

  // Approval wrapper — publishes approval requests on the session event bus
  // so every connected client (in any process) sees them.
  const approvalWrapper = (tool: ToolDefinition): ToolDefinition =>
    wrapWithApprovalGate(tool, authResult.userId, sessionId, getPolicy, (req: ApprovalRequest) => {
      publishSessionEvent(sessionId, "tool_approval_request", {
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        expiresAt: new Date(req.expiresAt).toISOString(),
      }).catch((err) => {
        console.error("Failed to publish approval request:", err);
      });
    });

  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[chat:${sessionId}] ${tag}`, ...args);

  // ── Reconnect position (SSE Last-Event-ID) ────────────────────────────
  const lastEventIdHeader = request.headers.get("last-event-id");
  const url = new URL(request.url);
  const lastEventIdQuery = url.searchParams.get("lastEventId");
  const lastEventId = lastEventIdHeader
    ? parseInt(lastEventIdHeader, 10)
    : lastEventIdQuery
      ? parseInt(lastEventIdQuery, 10)
      : -1;

  // ── Decision inputs ───────────────────────────────────────────────────
  // Queued messages (submitted while a generation ran) are not part of the
  // conversation: they are delivered by the drain below, not by the normal
  // prompt path, so they must not be mistaken for the last user message.
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId, queuedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      attachments: {
        select: { storagePath: true, mimeType: true },
      },
    },
  });
  const lastMessage = messages[messages.length - 1];

  const [isGenerating, generationStartedAt, pendingPromptMessageId, bufferedEvents, queuedCount] =
    await Promise.all([
      isSessionActive(authResult.userId, sessionId),
      getGenerationStartedAt(sessionId),
      getPendingPrompt(sessionId),
      getBufferedEvents(sessionId, lastEventId),
      countQueuedMessages(sessionId),
    ]);
  const bufferHasDone = bufferedEvents.some((e) => e.event === "done" || e.event === "error");
  const bufferHasEvents = bufferedEvents.length > 0;

  // Did the last user message already receive a response?
  let hasAssistantAfterLastUser = false;
  if (lastMessage && lastMessage.role === "user") {
    const response = await prisma.chatMessage.findFirst({
      where: { sessionId, role: "assistant", createdAt: { gt: lastMessage.createdAt } },
      select: { id: true },
    });
    hasAssistantAfterLastUser = !!response;
  }

  const poolKey = getPoolKey(authResult.userId, sessionId);
  const pooled = getPoolEntry(poolKey);

  const lastMessageForDecision: DbMessage | undefined = lastMessage
    ? {
        id: lastMessage.id,
        role: lastMessage.role as DbMessage["role"],
        content: lastMessage.content,
      }
    : undefined;

  let action: StreamAction = decideStreamAction({
    lastMessage: lastMessageForDecision,
    hasAssistantAfterLastUser,
    isGenerating,
    generationStartedAt,
    poolLastPromptedMessageId: pooled?.lastPromptedMessageId ?? null,
    pendingPromptMessageId,
    bufferHasDone,
    bufferHasEvents,
  });
  log("decision", `${action.type} (${action.reason}), lastEventId=${lastEventId}`);

  // ── Model resolution (prompt path only) ───────────────────────────────
  let modelProvider = chatSession.modelProvider || undefined;
  let modelName = chatSession.modelName || undefined;

  if (!modelProvider || !modelName) {
    const resolved = await resolveModelForPurpose(authResult.userId, "chat", undefined);
    if (resolved) {
      modelProvider = resolved.provider;
      modelName = resolved.name;
    }
  }

  if (action.type === "prompt" && (!modelProvider || !modelName)) {
    unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
    log("decision", "no model configured — returning error stream");
    const encoder = new TextEncoder();
    const errorEvent = encoder.encode(
      `event: error\ndata: ${JSON.stringify({ message: "No AI model configured. Please select a model in Settings > AI & Models." })}\n\n`,
    );
    const doneEvent = encoder.encode(`event: done\ndata: {}\n\n`);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(errorEvent);
          controller.enqueue(doneEvent);
          controller.close();
        },
      }),
      { headers: SSE_HEADERS },
    );
  }

  // ── Stream lifecycle state ────────────────────────────────────────────
  // Declared before the prompt helpers: a failed run closes the stream, and
  // the helpers are shared by the connection that prompts and by the queue
  // drain that runs after it settles.
  //
  // Client disconnects are NOT reliably signalled by `request.signal` abort
  // in Next.js route handlers — often it never fires at all. The runtime
  // always calls the source's `cancel()` when the response body stream is
  // torn down, so that hook is the source of truth. Without it, a dead
  // connection's heartbeat keeps ticking on a closed controller and throws
  // ERR_INVALID_STATE every interval.
  let streamController: ReadableStreamDefaultController | null = null;
  let heartbeat: SseHeartbeat | null = null;
  let streamClosed = false;

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    heartbeat?.stop();
    if (streamController) {
      try {
        streamController.close();
      } catch (err) {
        console.error("Failed to close controller (may already be closed):", err);
      }
    }
  };

  // ── Prompt helpers ────────────────────────────────────────────────────
  // One code path prompts every message: the message a POST claimed, and
  // every message the send queue drains afterwards.

  /** A message this connection can hand to the agent. */
  interface PromptTarget {
    id: string;
    content: string;
    attachments: { storagePath: string; mimeType: string }[];
  }

  interface PreparedRun {
    entry: Awaited<ReturnType<typeof createAndPool>>;
    target: PromptTarget;
    images: ImageContent[];
  }

  /**
   * Collect vision content for a message's image attachments. Non-image files
   * are referenced by path in the message content instead (the agent reads
   * them from its workspace).
   */
  const loadPromptImages = async (
    attachments: PromptTarget["attachments"],
  ): Promise<ImageContent[]> => {
    const images: ImageContent[] = [];
    for (const att of attachments) {
      if (!att.mimeType.startsWith("image/")) continue;
      try {
        const { data, mimeType } = await readImageAsBase64(authResult.userId, att.storagePath);
        images.push({ type: "image" as const, data, mimeType });
      } catch (err) {
        console.error("Failed to load image for message:", err);
      }
    }
    return images;
  };

  /**
   * Claim this process's pooled agent for a message and make it runnable:
   * guard against a double prompt, register the generation (so other
   * connections observe instead of prompting), clear the previous run's
   * buffered events, wire DB persistence, and pre-load images.
   *
   * Returns null when a prompt is already in flight in this process — the
   * caller must not claim work it cannot deliver.
   */
  const prepareRun = async (target: PromptTarget): Promise<PreparedRun | null> => {
    const resolvedToolConfig: ToolConfig = chatSession.toolConfig
      ? { ...(chatSession.toolConfig as ToolConfig) }
      : {};
    const sessionDir = getSessionDir(authResult.userId, sessionId);

    const existingPoolEntry = getPoolEntry(poolKey);
    const entry = await createAndPool(poolKey, async () => {
      log("pool", "miss — creating new agent");
      const result = await createPersistentSession({
        userId: authResult.userId,
        sessionId,
        sessionDir,
        customTools: [],
        toolConfig: resolvedToolConfig,
        ...(modelProvider ? { modelProvider } : {}),
        ...(modelName ? { modelName } : {}),
        thinkingLevel: chatSession.thinkingLevel,
        wrapTool: approvalWrapper,
      });

      const systemPrompt = buildAgentSystemPrompt({
        customInstructions: userSettings?.agentCustomInstructions,
        toolConfig: resolvedToolConfig,
      });
      lockSystemPrompt(result.session, systemPrompt);

      return { session: result.session, sessionDir };
    });

    if (existingPoolEntry) {
      log("pool", `hit — lastPromptedMessageId=${entry.lastPromptedMessageId}`);
    }

    // Same-process double-prompt guard (recovery path race).
    if (entry.promptInFlight) return null;

    // Claim synchronously before any further awaits.
    entry.promptInFlight = true;
    entry.lastPromptedMessageId = target.id;

    // Signal the generation to other connections, then clear stale buffered
    // events from previous runs.
    await registerActiveSession(authResult.userId, sessionId);
    await markGenerationStart(sessionId);
    await resetSessionEvents(sessionId);

    // A previous run's tracker may still be publishing `done` and
    // unsubscribing. Wait for it: wiring a fresh tracker mid-teardown would
    // leave this run unpersisted (and double-publish its events).
    await waitForPersistenceTeardown(sessionId);
    wireSessionPersistence(sessionId, authResult.userId, entry.session);

    const images = await loadPromptImages(target.attachments);
    log("prompt", `claimed prompt for message ${target.id}`);
    return { entry, target, images };
  };

  /**
   * Dispatch a prepared run and resolve when it has fully settled
   * (`agent_settled` — after any error retry, auto-compaction, or queued
   * continuation).
   *
   * Uses session.prompt() — the same path the Pi TUI uses — NOT
   * session.agent.prompt(): the session wrapper runs the SDK's pre-prompt
   * compaction check and post-run processing, and only settles when the run
   * is truly finished. The custom system prompt survives the preflight
   * because lockSystemPrompt() replaced the SDK's base prompt.
   */
  const dispatchRun = async (run: PreparedRun): Promise<boolean> => {
    log("prompt", `sending prompt, message.id=${run.target.id}`);
    try {
      await (run.images.length > 0
        ? run.entry.session.prompt(run.target.content, { images: run.images })
        : run.entry.session.prompt(run.target.content));
      run.entry.promptInFlight = false;
      log("prompt", "session.prompt() settled");
      return true;
    } catch (err) {
      run.entry.promptInFlight = false;
      run.entry.lastPromptedMessageId = null;
      console.error("session.prompt() failed:", err);
      unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
      // Notify connected clients, then clear the buffer so a later connect can
      // retry the prompt instead of replaying the error.
      publishSessionEvent(sessionId, "error", {
        message: err instanceof Error ? err.message : String(err),
      }).catch(console.error);
      publishSessionEvent(sessionId, "done", {}).catch(console.error);
      resetSessionEvents(sessionId).catch(console.error);
      closeStream();
      return false;
    }
  };

  /**
   * Deliver every queued message, one run each.
   *
   * Runs server-side, so queued messages are answered even when every client
   * has navigated away: the drain is chained off the previous run's settle,
   * and the promise chain outlives the SSE connection.
   */
  const drainQueue = async (): Promise<void> => {
    await drainSendQueue({
      isPromptInFlight: () => getPoolEntry(poolKey)?.promptInFlight === true,
      claimNext: () => claimNextQueuedMessage(sessionId),
      run: async (message) => {
        let prepared: PreparedRun | null;
        try {
          prepared = await prepareRun({
            id: message.id,
            content: message.content,
            attachments: message.attachments,
          });
        } catch (err) {
          console.error(`Failed to prepare queued message ${message.id}:`, err);
          return false;
        }
        if (!prepared) return false;
        log("queue", `delivering queued message ${message.id}`);
        await dispatchRun(prepared);
        return true;
      },
      restore: (message) => restoreQueuedMessage(sessionId, message.id, message.queuedAt),
      publishQueue: () => publishQueueUpdate(sessionId),
      log: (message) => log("queue", message),
    });
  };

  /**
   * Drain without letting a failure escape: the callers are fire-and-forget
   * (a settled run, an idle connection), and an unhandled rejection there has
   * nowhere to surface.
   */
  const drainQueueSafely = (): void => {
    drainQueue().catch((err) => {
      console.error(`Send queue drain failed for session ${sessionId}:`, err);
    });
  };

  // ── Prompt path: claim, pool, wire persistence ────────────────────────
  // The prompt is claimed atomically (GETDEL of the pending-prompt key) so
  // concurrent connections never double-prompt. `promptInFlight` on the pool
  // entry guards the recovery path (no pending key) within this process.
  let pendingRun: PreparedRun | null = null;

  if (action.type === "prompt" && lastMessage && lastMessage.role === "user") {
    const claim = await claimPendingPrompt(sessionId);
    if (pendingPromptMessageId === lastMessage.id && claim !== lastMessage.id) {
      // We raced another connection for the POST's pending prompt and lost.
      action = { type: "observe", reason: "prompt claim lost to another connection" };
      log("decision", `revised to observe (lost prompt claim)`);
    } else {
      pendingRun = await prepareRun({
        id: lastMessage.id,
        content: lastMessage.content,
        attachments: lastMessage.attachments,
      });
      if (!pendingRun) {
        action = { type: "observe", reason: "prompt already in flight" };
        log("decision", "revised to observe (prompt already in flight)");
      }
    }
  }

  // ── SSE stream ────────────────────────────────────────────────────────
  const dispatcher = getDispatcher(sessionId);

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
      let aborted = false;

      // ── Heartbeat: keep the connection alive through idle proxies and give
      //    the client's watchdog a liveness signal (see SSE_HEARTBEAT_INTERVAL_MS).
      heartbeat = createSseHeartbeat(controller, SSE_HEARTBEAT_INTERVAL_MS);

      dispatcher
        .subscribe(controller, new TextEncoder(), lastEventId)
        .then(async () => {
          if (aborted) {
            dispatcher.unsubscribe(controller);
            return;
          }

          // ── Pending-approval snapshot: the server's view of outstanding
          //    approvals, emitted AFTER the buffered replay. The client
          //    replaces its local list with this, so stale cards (resolved
          //    elsewhere, expired, or orphaned by a crashed generation) can
          //    never linger — and live `tool_approval_request`/`resolved`
          //    events keep it in sync afterwards.
          const pendingApprovals = await getPendingApprovals(sessionId);
          dispatcher.emitLocal(controller, "approvals_snapshot", {
            approvals: pendingApprovals.map((a) => ({
              toolCallId: a.toolCallId,
              toolName: a.toolName,
              args: a.args,
              expiresAt: new Date(a.expiresAt).toISOString(),
            })),
          });

          // ── Idle: nothing to stream right now — emit done so the client
          //    settles its loading state, but KEEP the connection open: a
          //    generation started later (another tab, Telegram worker) will
          //    stream on this same connection.
          if (action.type === "done") {
            log("stream", "idle — emitting done, staying open as observer");
            dispatcher.emitLocal(controller, "done", {});

            // Recovery drain: a run that died (process restart, crash) can
            // strand messages in the send queue. Deliver them now that the
            // session is idle — and keep the connection open, the drain
            // streams through this same dispatcher.
            if (queuedCount > 0) drainQueueSafely();
            return;
          }

          // ── Prompt: dispatch the agent, forward events via the bus ────
          // The run is dispatched here, after the subscription is in place,
          // so the client receives the live stream. When it settles, the send
          // queue drains — messages submitted during this run are delivered
          // next, in order.
          if (action.type === "prompt" && pendingRun) {
            void dispatchRun(pendingRun).then(drainQueueSafely);
          }
        })
        .catch((err) => {
          console.error("Failed to subscribe stream:", err);
          closeStream();
        });

      // ── Client disconnect: stop forwarding; the agent keeps running and
      //    other clients (and the buffer) keep receiving events. ─────────
      request.signal.addEventListener("abort", () => {
        aborted = true;
        log("client", "disconnect detected, stopping SSE forwarding (agent continues)");
        dispatcher.unsubscribe(controller);
        closeStream();
      });
    },
    cancel() {
      // Definitive client-disconnect signal: the response body stream was
      // cancelled (tab closed, navigation, network drop, watchdog reconnect).
      // `request.signal` abort often never fires in Next.js, so without this
      // hook the heartbeat would keep ticking on a closed controller and
      // spam ERR_INVALID_STATE errors every interval — and the dead client
      // would stay registered in the dispatcher, erroring on every live
      // event. Clean up both here.
      log("client", "stream cancelled, stopping SSE forwarding (agent continues)");
      if (streamController) {
        dispatcher.unsubscribe(streamController);
      }
      closeStream();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
