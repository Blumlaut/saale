import type { NextRequest } from "next/server";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  claimPendingPrompt,
  getPendingPrompt,
  isSendQueueHeld,
  isSessionActive,
  unregisterActiveSession,
} from "@/lib/redis";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { readImageAsBase64 } from "@/lib/image-attachment";
import type { ImageContent } from "@/lib/pi/message-replay";
import { get as getPoolEntry, getDispatcher, getPoolKey } from "@/lib/pi/agent-pool";
import { applyPendingHistoryRewind, rewindDuplicatePrompt } from "@/lib/pi/message-rewind";
import {
  decideStaleGenerationAction,
  decideStreamAction,
  type DbMessage,
  type StreamAction,
} from "@/lib/pi/stream-logic";
import { getLastBufferedEvent, isTerminalBufferedEvent } from "@/lib/pi/sse-buffer";
import { createSseHeartbeat, type SseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { clearActiveToolState } from "@/lib/chat/active-tool-state";
import {
  beginChatRun,
  dispatchChatRun,
  ensureChatAgent,
  type PooledChatSession,
} from "@/lib/chat/agent-run";
import {
  claimNextQueuedMessage,
  countQueuedMessages,
  publishQueueUpdate,
  queueMessage,
  restoreQueuedMessage,
} from "@/lib/chat/queue";
import { drainSendQueue } from "@/lib/chat/drain-queue";
import { getPendingApprovals, toApprovalPayload } from "@/lib/pi/tool-approval-gate";

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
 * How often a connection observing someone else's generation checks that it is
 * still alive.
 *
 * The generation's liveness heartbeat (see redis.ts) expires within seconds of
 * the owning process dying, and this poll converts that into a re-decision: the
 * clients are settled, the connection closes, the browser reconnects, and the
 * fresh request resumes the unanswered message. Together they bound a restart's
 * freeze to well under a minute.
 */
const STALE_GENERATION_POLL_MS = 10_000;

/**
 * GET /api/chat/sessions/:sessionId/stream. SSE streaming endpoint
 *
 * Pure observer: wires the HTTP response to the session's event stream
 * (Redis buffer replay + live pub/sub fan-out) and, when the last user
 * message is unanswered, claims and dispatches the prompt.
 *
 * No DB writes happen here. all persistence is handled by the session
 * event tracker (wired once per pooled session). Multiple clients may
 * connect concurrently (multiple tabs, reconnects, other processes); every
 * connection sees the same live stream.
 *
 * Uses Last-Event-ID for SSE-spec-compliant reconnection:
 * - Browser's EventSource automatically sends Last-Event-ID on reconnect
 * - The dispatcher replays buffered events after that ID, then forwards live
 *
 * Emits: turn_start, token, thinking, tool_pending, tool_start, tool_update,
 * tool_end, turn_end, message_saved, token_usage, compaction_start,
 * compaction_end, done, error, tool_approval_request, queue_update,
 * messages_changed, plugin_ui_request, plugin_notice, plugin_status
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

  // ── User settings are loaded per run by `ensureChatAgent` ─────────────

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
  //
  // The decision only needs the LAST message: one indexed lookup (the
  // [sessionId, createdAt] index, scanned backwards) instead of loading
  // every message the session has ever had, on every SSE connection.
  const lastMessage = await prisma.chatMessage.findFirst({
    where: { sessionId, queuedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      attachments: {
        select: { storagePath: true, mimeType: true },
      },
    },
  });

  const [isGenerating, pendingPromptMessageId, bufferedTail, queuedCount, queueHeld] =
    await Promise.all([
      isSessionActive(authResult.userId, sessionId),
      getPendingPrompt(sessionId),
      getLastBufferedEvent(sessionId),
      countQueuedMessages(sessionId),
      isSendQueueHeld(sessionId),
    ]);
  // A finished run stays marked in the buffer so a reconnect cannot re-prompt
  // it. It is never replayed (see `liveRunEvents`), so the decision has to
  // settle the client itself.
  const bufferHasDone = bufferedTail !== null && isTerminalBufferedEvent(bufferedTail);

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
    poolLastPromptedMessageId: pooled?.lastPromptedMessageId ?? null,
    pendingPromptMessageId,
    bufferHasDone,
    queueHeld,
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
    log("decision", "no model configured. returning error stream");
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
  // in Next.js route handlers. often it never fires at all. The runtime
  // always calls the source's `cancel()` when the response body stream is
  // torn down, so that hook is the source of truth. Without it, a dead
  // connection's heartbeat keeps ticking on a closed controller and throws
  // ERR_INVALID_STATE every interval.
  let streamController: ReadableStreamDefaultController | null = null;
  let heartbeat: SseHeartbeat | null = null;
  let streamClosed = false;

  // ── Stale-generation supervisor ───────────────────────────────────────
  // A connection that decided to observe a generation it does not own (another
  // tab, the Telegram worker) has no other way to learn that its owner died:
  // the buffered events replay as if it were still running, and this server's
  // heartbeats keep the transport quietly alive. Polling the generation's
  // liveness key turns that into a re-decision. settle the clients, close,
  // and let the browser's reconnect resume the unanswered message.
  let supervisorTimer: ReturnType<typeof setInterval> | null = null;
  const stopSupervisor = () => {
    if (supervisorTimer) {
      clearInterval(supervisorTimer);
      supervisorTimer = null;
    }
  };

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    stopSupervisor();
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
    entry: PooledChatSession;
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
   * Returns null when a prompt is already in flight in this process. the
   * caller must not claim work it cannot deliver.
   */
  const prepareRun = async (target: PromptTarget): Promise<PreparedRun | null> => {
    const { entry, existedAlready } = await ensureChatAgent({
      userId: authResult.userId,
      sessionId,
      chatSession,
      ...(modelProvider && modelName
        ? { model: { provider: modelProvider, name: modelName } }
        : {}),
      log,
    });

    if (existedAlready) {
      log("pool", `hit. lastPromptedMessageId=${entry.lastPromptedMessageId}`);
    }

    // Same-process double-prompt guard (recovery path race).
    if (entry.promptInFlight) return null;

    // Claim synchronously before any further awaits.
    entry.promptInFlight = true;
    entry.lastPromptedMessageId = target.id;

    // A run that died mid-flight (restart, crash) left its prompt in the
    // transcript with no reply, and this recovery is about to re-prompt it:
    // rewind first so the prompt replaces that entry instead of appending a
    // second copy of the same message (see message-rewind.ts).
    if (await rewindDuplicatePrompt(entry.session, { content: target.content })) {
      log("rewind", `transcript already held message ${target.id}. rewound before it`);
    }

    // An edited message still has the history its edit deleted in the agent
    // transcript. rewind it, or the prompt lands as a brand new message after
    // the old conversation (see message-rewind.ts).
    const rewind = await applyPendingHistoryRewind(sessionId, entry.session, target.id);
    if (rewind !== "nothing-pending") {
      log("rewind", `${rewind} for message ${target.id}`);
    }

    // Publish the generation, clear stale buffered events, and wire DB
    // persistence. shared with the `chat_respond` tool's server-side runs.
    await beginChatRun({ userId: authResult.userId, sessionId, session: entry.session });

    const images = await loadPromptImages(target.attachments);
    log("prompt", `claimed prompt for message ${target.id}`);
    return { entry, target, images };
  };

  /**
   * Dispatch a prepared run and resolve when it has fully settled
   * (`agent_settled`. after any error retry, auto-compaction, or queued
   * continuation).
   *
   * Uses session.prompt(). the same path the Pi TUI uses. NOT
   * session.agent.prompt(): the session wrapper runs the SDK's pre-prompt
   * compaction check and post-run processing, and only settles when the run
   * is truly finished. The custom system prompt survives the per-turn prompt
   * resolution because it comes from the session's resource loader.
   */
  const dispatchRun = async (run: PreparedRun): Promise<boolean> => {
    return dispatchChatRun({
      userId: authResult.userId,
      sessionId,
      entry: run.entry,
      content: run.target.content,
      images: run.images,
      log,
      onRunFailed: closeStream,
    });
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
      // A stopped session does not send: the hold is released by the user's
      // next message or by pushing a queued one.
      claimNext: async () =>
        (await isSendQueueHeld(sessionId)) ? null : claimNextQueuedMessage(sessionId),
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
        // Another connection got the run, so this one cannot hand its message
        // over. Queue it behind that run, or it sits in the conversation with
        // nothing left to answer it. Unless that run is prompting this very
        // message: then queuing it would deliver it a second time.
        const ownedElsewhere = getPoolEntry(poolKey)?.lastPromptedMessageId === lastMessage.id;
        if (!ownedElsewhere && (await queueMessage(sessionId, lastMessage.id))) {
          log("queue", `queued message ${lastMessage.id} behind the run in flight`);
          await publishQueueUpdate(sessionId);
        }
        action = { type: "observe", reason: "prompt already in flight" };
        log("decision", "revised to observe (prompt already in flight)");
      }
    }
  }

  // ── SSE stream ────────────────────────────────────────────────────────
  const dispatcher = getDispatcher(sessionId);

  /**
   * Watch a generation this connection does not own, and recover it if it dies.
   *
   * This is the restart case: Saale is redeployed (or crashes) while a run is
   * streaming, so the run is gone but its clients are still connected, replay
   * a frozen partial stream, and would wait forever. the transport itself
   * looks perfectly healthy. Once the generation's liveness heartbeat is gone
   * and this process has no run of its own, settle every client and close the
   * stream: the browser reconnects, the fresh request re-decides with the dead
   * generation off the books, and the unanswered message is prompted again.
   *
   * The buffered `done` check keeps a normally finished run from looking dead
   *. its client already settled from the `done` the decision emits.
   */
  const startGenerationSupervisor = () => {
    if (supervisorTimer) return;
    supervisorTimer = setInterval(() => {
      void (async () => {
        try {
          const local = getPoolEntry(poolKey);
          const bufferTail = await getLastBufferedEvent(sessionId);
          const next = decideStaleGenerationAction({
            isActiveElsewhere: await isSessionActive(authResult.userId, sessionId),
            localRunInFlight: local?.promptInFlight === true || local?.session.isStreaming === true,
            bufferTailIsTerminal: bufferTail !== null && isTerminalBufferedEvent(bufferTail),
          });
          // The run this connection was waiting on finished on its own. its
          // clients already settled from that event (or it is still running,
          // here or elsewhere).
          if (next === "keep-watching") return;
          if (next === "stop") {
            stopSupervisor();
            return;
          }

          log("supervisor", "observed generation is gone. settling clients and reconnecting");
          stopSupervisor();
          // Nothing is running, so nothing is running a tool: drop the
          // bookkeeping the dead run left behind before clients reload.
          await clearActiveToolState(sessionId, authResult.userId).catch((err) => {
            console.error(`Failed to clear stale active tool state for ${sessionId}:`, err);
          });
          if (streamController) dispatcher.emitLocal(streamController, "done", {});
          closeStream();
        } catch (err) {
          console.error(`Generation supervisor failed for session ${sessionId}:`, err);
        }
      })();
    }, STALE_GENERATION_POLL_MS);
    supervisorTimer.unref?.();
  };

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
            // The client left while its workspace was being built (a checkout
            // plus an install takes minutes, and `prepareRun` above claims the
            // prompt before the response even starts). The run is this
            // process's, not the connection's: dispatch it anyway, or the
            // claimed prompt dies with the closed tab. `promptInFlight` would
            // stay set, and every later connection would treat the chat as
            // already answered. Runs its own subscriberless stream: the events
            // land in the buffer and a returning client replays them.
            if (action.type === "prompt" && pendingRun) {
              log("stream", "client gone before dispatch. running anyway");
              void dispatchRun(pendingRun).then(drainQueueSafely);
            }
            return;
          }

          // ── Pending-approval snapshot: the server's view of outstanding
          //    approvals, emitted AFTER the buffered replay. The client
          //    replaces its local list with this, so stale cards (resolved
          //    elsewhere, expired, or orphaned by a crashed generation) can
          //    never linger. and live `tool_approval_request`/`resolved`
          //    events keep it in sync afterwards.
          const pendingApprovals = await getPendingApprovals(sessionId);
          dispatcher.emitLocal(controller, "approvals_snapshot", {
            approvals: pendingApprovals.map(toApprovalPayload),
          });

          // ── Idle: nothing to stream right now. emit done so the client
          //    settles its loading state, but KEEP the connection open: a
          //    generation started later (another tab, Telegram worker) will
          //    stream on this same connection.
          if (action.type === "done") {
            log("stream", "idle. emitting done, staying open as observer");
            dispatcher.emitLocal(controller, "done", {});

            // Recovery drain: a run that died (process restart, crash) can
            // strand messages in the send queue. Deliver them now that the
            // session is idle. and keep the connection open, the drain
            // streams through this same dispatcher.
            if (queuedCount > 0) drainQueueSafely();
            return;
          }

          // ── Prompt: dispatch the agent, forward events via the bus ────
          // The run is dispatched here, after the subscription is in place,
          // so the client receives the live stream. When it settles, the send
          // queue drains. messages submitted during this run are delivered
          // next, in order.
          if (action.type === "prompt" && pendingRun) {
            void dispatchRun(pendingRun).then(drainQueueSafely);
            return;
          }

          // ── Observe: waiting on a generation owned elsewhere ──────────
          // This is where a restart strands clients. the run is replayed as
          // if it were still going, so watch it and recover (see
          // startGenerationSupervisor).
          if (action.type === "observe") startGenerationSupervisor();
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
      // spam ERR_INVALID_STATE errors every interval. and the dead client
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
