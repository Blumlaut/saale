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
import { wireSessionPersistence } from "@/lib/pi/session-persistence";
import { decideStreamAction, type DbMessage, type StreamAction } from "@/lib/pi/stream-logic";
import { getBufferedEvents } from "@/lib/pi/sse-buffer";
import { createSseHeartbeat, type SseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { publishSessionEvent, resetSessionEvents } from "@/lib/pi/session-events";
import { buildAgentSystemPrompt, lockSystemPrompt } from "@/lib/pi/processing-state";
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
 * tool_approval_request
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
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: {
      attachments: {
        select: { storagePath: true, mimeType: true },
      },
    },
  });
  const lastMessage = messages[messages.length - 1];

  const [isGenerating, generationStartedAt, pendingPromptMessageId, bufferedEvents] =
    await Promise.all([
      isSessionActive(authResult.userId, sessionId),
      getGenerationStartedAt(sessionId),
      getPendingPrompt(sessionId),
      getBufferedEvents(sessionId, lastEventId),
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

  // ── Prompt path: claim, pool, wire persistence ────────────────────────
  // The prompt is claimed atomically (GETDEL of the pending-prompt key) so
  // concurrent connections never double-prompt. `promptInFlight` on the pool
  // entry guards the recovery path (no pending key) within this process.
  let promptSession: Awaited<ReturnType<typeof createAndPool>> | null = null;
  const lastMessageImages: ImageContent[] = [];

  if (action.type === "prompt" && lastMessage && lastMessage.role === "user") {
    const claim = await claimPendingPrompt(sessionId);
    if (pendingPromptMessageId === lastMessage.id && claim !== lastMessage.id) {
      // We raced another connection for the POST's pending prompt and lost.
      action = { type: "observe", reason: "prompt claim lost to another connection" };
      log("decision", `revised to observe (lost prompt claim)`);
    } else {
      const resolvedToolConfig: ToolConfig = chatSession.toolConfig
        ? { ...(chatSession.toolConfig as ToolConfig) }
        : {};
      const sessionDir = getSessionDir(authResult.userId, sessionId);

      const existingPoolEntry = getPoolEntry(poolKey);
      promptSession = await createAndPool(poolKey, async () => {
        log("pool", "miss — creating new agent");
        const result = await createPersistentSession({
          userId: authResult.userId,
          sessionId,
          sessionDir,
          customTools: [],
          toolConfig: resolvedToolConfig,
          ...(modelProvider ? { modelProvider } : {}),
          ...(modelName ? { modelName } : {}),
          thinkingLevel: chatSession.thinkingLevel || "off",
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
        log("pool", `hit — lastPromptedMessageId=${promptSession.lastPromptedMessageId}`);
      }

      // Same-process double-prompt guard (recovery path race).
      if (promptSession.promptInFlight) {
        action = { type: "observe", reason: "prompt already in flight" };
        log("decision", "revised to observe (prompt already in flight)");
      } else {
        // Claim synchronously before any further awaits.
        promptSession.promptInFlight = true;
        promptSession.lastPromptedMessageId = lastMessage.id;

        // Signal the generation to other connections, then clear stale
        // buffered events from previous runs.
        await registerActiveSession(authResult.userId, sessionId);
        await markGenerationStart(sessionId);
        await resetSessionEvents(sessionId);

        // Wire persistence exactly once per pooled session.
        wireSessionPersistence(sessionId, authResult.userId, promptSession.session);

        // Pre-load images for the current user message. Only image
        // attachments are vision content — other file types are referenced
        // by path in the message content (uploads/ in the agent workspace).
        if (lastMessage.attachments.length > 0) {
          for (const att of lastMessage.attachments) {
            if (!att.mimeType.startsWith("image/")) continue;
            try {
              const { data, mimeType } = await readImageAsBase64(
                authResult.userId,
                att.storagePath,
              );
              lastMessageImages.push({ type: "image" as const, data, mimeType });
            } catch (err) {
              console.error("Failed to load image for current message:", err);
            }
          }
        }

        log("prompt", `claimed prompt for message ${lastMessage.id}`);
      }
    }
  }

  // ── SSE stream ────────────────────────────────────────────────────────
  const dispatcher = getDispatcher(sessionId);

  // Stream lifecycle state, shared between `start` (heartbeat + forwarding)
  // and `cancel` (the source's teardown hook) below.
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
            return;
          }

          // ── Prompt: dispatch the agent, forward events via the bus ────
          // Uses session.prompt() — the same path the Pi TUI uses — NOT
          // session.agent.prompt(). The session wrapper runs the SDK's
          // pre-prompt compaction check and post-run processing (error
          // retry, auto-compaction at the run boundary, agent.continue()
          // after overflow recovery) and only settles (agent_settled) when
          // everything is truly done. The custom system prompt survives the
          // preflight because lockSystemPrompt() replaced the SDK's base
          // prompt. The promise resolves on settle, so promptInFlight stays
          // set across any post-run compaction (no re-dispatch races).
          if (action.type === "prompt" && promptSession && lastMessage?.role === "user") {
            log("prompt", `sending prompt, message.id=${lastMessage.id}`);

            const promptPromise =
              lastMessageImages.length > 0
                ? promptSession.session.prompt(lastMessage.content, { images: lastMessageImages })
                : promptSession.session.prompt(lastMessage.content);

            promptPromise
              .then(() => {
                promptSession!.promptInFlight = false;
                log("prompt", "session.prompt() settled");
              })
              .catch((err) => {
                promptSession!.promptInFlight = false;
                promptSession!.lastPromptedMessageId = null;
                console.error("session.prompt() failed:", err);
                unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
                // Notify connected clients, then clear the buffer so a later
                // connect can retry the prompt instead of replaying the error.
                publishSessionEvent(sessionId, "error", { message: err.message }).catch(
                  console.error,
                );
                publishSessionEvent(sessionId, "done", {}).catch(console.error);
                resetSessionEvents(sessionId).catch(console.error);
                closeStream();
              });
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
