import type { NextRequest } from "next/server";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { requireChatSessionOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { registerActiveSession, unregisterActiveSession } from "@/lib/redis";
import { type ToolConfig } from "@/lib/pi/session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { readImageAsBase64 } from "@/lib/image-attachment";
import type { ImageContent } from "@/lib/pi/message-replay";
import {
  getPoolKey,
  getSessionDir,
  createAndPool,
  get as getPoolEntry,
  getDispatcher,
} from "@/lib/pi/agent-pool";
import { createPersistentSession } from "@/lib/pi/persistent-session";
import { wireSessionPersistence } from "@/lib/pi/session-persistence";
import { evaluatePromptGuard, evaluateReconnectAction } from "@/lib/pi/stream-logic";
import { getBufferedEvents } from "@/lib/pi/sse-buffer";
import { buildAgentSystemPrompt, clearProcessingSince } from "@/lib/pi/processing-state";
import { wrapWithApprovalGate, type ApprovalRequest } from "@/lib/pi/tool-approval-gate";
import { getDefaultPolicy } from "@/lib/pi/tool-infos";

/**
 * GET /api/chat/sessions/:sessionId/stream — SSE streaming endpoint
 *
 * Pure observer: wires the dispatcher to the HTTP response and forwards
 * events emitted by the session-scoped persistence handler. No DB writes
 * happen here — all persistence is handled by wireSessionPersistence()
 * which subscribes exactly once per pooled session.
 *
 * Uses Last-Event-ID header for SSE-spec-compliant reconnection:
 * - Browser's EventSource automatically sends Last-Event-ID on reconnect
 * - Server replays buffered events from Redis sorted set
 * - Then subscribes to live agent events via the pooled dispatcher
 *
 * Emits: token, thinking, tool_start, tool_end, turn_end, message_saved, done,
 *         compaction_start, compaction_end, error, tool_approval_request
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

  // ── User settings (system prompt + tool policies) ─────────────────────
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.userId },
    select: { agentCustomInstructions: true, toolPolicies: true },
  });

  const toolPolicies = userSettings?.toolPolicies as Record<string, "off" | "ask" | "allow"> | null;
  const getPolicy = async (toolName: string): Promise<"off" | "ask" | "allow"> =>
    toolPolicies?.[toolName] ?? getDefaultPolicy(toolName);

  // ── Dispatcher (per-session, survives across requests) ────────────────
  const dispatcher = getDispatcher(sessionId);

  // Approval wrapper — emits approval requests through the dispatcher
  const approvalWrapper = (tool: ToolDefinition): ToolDefinition =>
    wrapWithApprovalGate(tool, authResult.userId, sessionId, getPolicy, (req: ApprovalRequest) => {
      dispatcher.emit("tool_approval_request", {
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        expiresAt: new Date(req.expiresAt).toISOString(),
      });
    });

  if (!chatSession) {
    return new Response("Not found", { status: 404 });
  }

  // ── Tool config ───────────────────────────────────────────────────────
  const resolvedToolConfig: ToolConfig = chatSession.toolConfig
    ? { ...(chatSession.toolConfig as ToolConfig) }
    : {};

  // ── Model resolution ──────────────────────────────────────────────────
  let modelProvider = chatSession.modelProvider || undefined;
  let modelName = chatSession.modelName || undefined;

  if (!modelProvider || !modelName) {
    const resolved = await resolveModelForPurpose(authResult.userId, "chat", undefined);
    if (resolved) {
      modelProvider = resolved.provider;
      modelName = resolved.name;
    }
  }

  // No model available — return an error stream
  if (!modelProvider || !modelName) {
    clearProcessingSince(sessionId).catch(console.error);

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
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    );
  }

  // ── Debug log prefix ──────────────────────────────────────────────────
  const log = (tag: string, ...args: unknown[]) =>
    // eslint-disable-next-line no-console
    console.log(`[chat:${sessionId}] ${tag}`, ...args);

  // ── Agent pool ────────────────────────────────────────────────────────
  const poolKey = getPoolKey(authResult.userId, sessionId);
  const sessionDir = getSessionDir(authResult.userId, sessionId);

  const existingPoolEntry = getPoolEntry(poolKey);
  const pooled = await createAndPool(poolKey, async () => {
    log("pool", "miss — creating new agent");
    const result = await createPersistentSession({
      userId: authResult.userId,
      sessionId,
      sessionDir,
      customTools: [],
      toolConfig: resolvedToolConfig,
      modelProvider,
      modelName,
      thinkingLevel: chatSession.thinkingLevel || "off",
      wrapTool: approvalWrapper,
    });

    result.session.agent.state.systemPrompt = buildAgentSystemPrompt({
      customInstructions: userSettings?.agentCustomInstructions,
      toolConfig: resolvedToolConfig,
    });

    return { session: result.session, sessionDir };
  });

  if (existingPoolEntry) {
    log(
      "pool",
      `hit — isStreaming=${pooled.session.isStreaming}, lastPromptedMessageId=${pooled.lastPromptedMessageId}`,
    );
  }

  // ── Wire session persistence (idempotent — runs once per pooled session) ─
  wireSessionPersistence(sessionId, authResult.userId, pooled.session);

  // ── Register session for cancellation ─────────────────────────────────
  await registerActiveSession(authResult.userId, sessionId);

  // ── Messages + prompt guard ───────────────────────────────────────────
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    include: {
      attachments: {
        select: {
          storagePath: true,
          mimeType: true,
        },
      },
    },
  });

  const lastMessage = messages[messages.length - 1];

  const promptGuard = evaluatePromptGuard(
    lastMessage
      ? {
          id: lastMessage.id,
          role: lastMessage.role as "user" | "assistant" | "toolResult" | "custom",
          content: lastMessage.content,
        }
      : undefined,
    pooled.lastPromptedMessageId,
  );
  const shouldPrompt = promptGuard.shouldPrompt;

  log(
    "prompt_guard",
    `shouldPrompt=${shouldPrompt} (${promptGuard.reason}), lastMessage.id=${lastMessage?.id}, role=${lastMessage?.role}, lastPromptedMessageId=${pooled.lastPromptedMessageId}`,
  );

  // ── Pre-load images for the current user message ──────────────────────
  const lastMessageImages: ImageContent[] = [];
  if (
    shouldPrompt &&
    lastMessage &&
    lastMessage.role === "user" &&
    lastMessage.attachments.length > 0
  ) {
    for (const att of lastMessage.attachments) {
      try {
        const { data, mimeType } = await readImageAsBase64(authResult.userId, att.storagePath);
        lastMessageImages.push({ type: "image" as const, data, mimeType });
      } catch (err) {
        console.error("Failed to load image for current message:", err);
      }
    }
  }

  // ── Reconnect: fetch buffered events (before creating the stream) ─────
  const lastEventIdHeader = request.headers.get("last-event-id");
  const url = new URL(request.url);
  const lastEventIdQuery = url.searchParams.get("lastEventId");
  const lastEventId = lastEventIdHeader
    ? parseInt(lastEventIdHeader, 10)
    : lastEventIdQuery
      ? parseInt(lastEventIdQuery, 10)
      : -1;
  const isReconnect = lastEventId >= 0;

  let bufferedEvents: { id: number; event: string; data: unknown }[] = [];
  let streamAlreadyFinished = false;

  const needsBufferReplay = isReconnect || (!shouldPrompt && pooled.lastPromptedMessageId);

  if (needsBufferReplay) {
    const fromId = isReconnect ? lastEventId : -1;
    log("reconnect", `replaying buffer from id ${fromId} (isReconnect=${isReconnect})`);
    bufferedEvents = (await getBufferedEvents(sessionId, fromId)) || [];
    log("reconnect", `fetched ${bufferedEvents.length} buffered events`);

    for (const evt of bufferedEvents) {
      if (evt.event === "done" || evt.event === "error") {
        streamAlreadyFinished = true;
        break;
      }
    }
  }

  // ── Determine reconnect action (when not prompting) ───────────────────
  let emitDoneImmediately = false;
  if (!shouldPrompt && pooled.lastPromptedMessageId && !streamAlreadyFinished) {
    const reconnectAction = evaluateReconnectAction(
      pooled.session.isStreaming,
      pooled.lastPromptedMessageId,
    );
    if (reconnectAction.type === "emit-done") {
      emitDoneImmediately = true;
      log("prompt_guard", `reconnect: ${reconnectAction.reason}, emitting done`);
    } else {
      log("prompt_guard", `reconnect: ${reconnectAction.reason}, waiting for events`);
    }
  }

  // ── Seed saved turns from DB for reconnect ─────────────────────────────
  let savedTurnsFromDb: number[] = [];
  if (!shouldPrompt && pooled.lastPromptedMessageId && !streamAlreadyFinished) {
    const assistantCount = await prisma.chatMessage.count({
      where: { sessionId, role: "assistant" },
    });
    if (assistantCount > 0) {
      savedTurnsFromDb = Array.from({ length: assistantCount }, (_, i) => i);
      log("reconnect", `seeded savedTurns from DB: [0..${assistantCount - 1}]`);
    }
  }

  // ── SSE stream ────────────────────────────────────────────────────────
  const encoder = new TextEncoder();

  function closeController(controller: ReadableStreamDefaultController): void {
    dispatcher.close();
    try {
      controller.close();
    } catch (err) {
      console.error("Failed to close controller (may already be closed):", err);
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      // Wire dispatcher to this controller — replaces any old connection
      dispatcher.wire(controller, encoder);

      // ── Replay buffered events (reconnect path) ──────────────────────
      if (bufferedEvents.length > 0) {
        if (savedTurnsFromDb.length > 0) {
          dispatcher.emitSync("saved_turns", { turns: savedTurnsFromDb }, -1);
        }
        for (const evt of bufferedEvents) {
          dispatcher.emitSync(evt.event, evt.data, evt.id);
        }
      }

      // ── Terminal: stream already finished in buffer ───────────────────
      if (streamAlreadyFinished) {
        log("reconnect", "stream already finished in buffer, closing");
        closeController(controller);
        return;
      }

      // ── Terminal: agent already finished ──────────────────────────────
      if (emitDoneImmediately) {
        dispatcher.emit("done", {});
        closeController(controller);
        return;
      }

      // ── Subscribe to agent events (forwarding only — no DB writes) ────
      // The persistence handler (wireSessionPersistence) already subscribes
      // and emits through the dispatcher. We subscribe here only to send
      // the initial prompt and handle errors.
      const unsubscribeForward = pooled.session.subscribe((event) => {
        // All event forwarding is handled by the persistence handler emitting
        // through the dispatcher. This subscription is only for prompt/error handling.
        if (event.type === "agent_end") {
          // Persistence handler will emit "done" — we just need to clean up
          // when the client disconnects.
        }
      });

      // ── Send prompt if needed ─────────────────────────────────────────
      if (shouldPrompt && lastMessage && lastMessage.role === "user") {
        pooled.lastPromptedMessageId = lastMessage.id;
        log("prompt", `sending prompt, message.id=${lastMessage.id}`);

        const promptPromise =
          lastMessageImages.length > 0
            ? pooled.session.agent.prompt(lastMessage.content, lastMessageImages)
            : pooled.session.agent.prompt(lastMessage.content);

        promptPromise
          .then(() => {
            log("prompt", "agent.prompt() resolved");
          })
          .catch((err) => {
            console.error("agent.prompt() failed:", err);
            unsubscribeForward();
            clearProcessingSince(sessionId).catch((updateErr) => {
              console.error("Failed to clear processingSince on error:", updateErr);
            });
            unregisterActiveSession(authResult.userId, sessionId).catch(console.error);
            dispatcher.emit("error", { message: err.message });
            dispatcher.emit("done", {});
            closeController(controller);
          });
      }

      // ── Client disconnect ──────────────────────────────────────────────
      request.signal.addEventListener("abort", () => {
        log("client", "disconnect detected, stopping SSE forwarding (agent continues)");
        unsubscribeForward();
        closeController(controller);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
