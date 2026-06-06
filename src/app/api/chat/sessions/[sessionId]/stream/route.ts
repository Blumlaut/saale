import { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createPiSession, type ToolConfig } from "@/lib/pi/session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import {
  normalizeToolResult,
  buildHistoryMessages,
  type StoredMessage,
  type ImageContent,
} from "@/lib/pi/message-replay";
import { readImageAsBase64 } from "@/lib/image-attachment";

/**
 * GET /api/chat/sessions/:sessionId/stream — SSE streaming endpoint
 *
 * Streams Pi agent responses as Server-Sent Events.
 * Emits: token (cumulative text for current turn), thinking (cumulative thinking for current turn),
 *         tool_start, tool_end, turn_end (completed turn data), done
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authResult.user.id },
    select: {
      id: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      toolConfig: true,
      processingSince: true,
    },
  });

  // Fetch user's custom agent system prompt
  const userSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.user.id },
    select: { agentSystemPrompt: true },
  });

  if (!chatSession) {
    return new Response("Not found", { status: 404 });
  }

  // Get all messages for context (with attachments for image support)
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

  // Resolve tool config to know which tool categories are enabled
  const resolvedToolConfig: ToolConfig = chatSession.toolConfig
    ? { ...(chatSession.toolConfig as ToolConfig) }
    : {};

  // Resolve model: session-level first, then fall back to user/admin defaults
  let modelProvider = chatSession.modelProvider || undefined;
  let modelName = chatSession.modelName || undefined;

  if (!modelProvider || !modelName) {
    const resolved = await resolveModelForPurpose(authResult.user.id, "chat", undefined);
    if (resolved) {
      modelProvider = resolved.provider;
      modelName = resolved.name;
    }
  }

  // No model available — return an error stream
  if (!modelProvider || !modelName) {
    // Clear in-progress flag so the user can try again
    prisma.chatSession
      .update({ where: { id: sessionId }, data: { processingSince: null } })
      .catch(console.error);

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

  // Create Pi session with custom tools (filtered by toolConfig)
  const { session: piSession } = await createPiSession({
    userId: authResult.user.id,
    customTools: [],
    ...(chatSession.toolConfig && { toolConfig: resolvedToolConfig }),
    modelProvider,
    modelName,
    thinkingLevel: chatSession.thinkingLevel || "off",
  });

  // Capture resolved model for consistent history reconstruction.
  // Using the actual model's api/provider/id ensures transformMessages treats
  // replayed messages as same-model (isSameModel=true), preserving thinking
  // blocks, tool signatures, etc. — critical for cache hits.
  const model = piSession.model;

  // Set up system prompt — use user-defined prompt if set, otherwise fall back to default
  const defaultSystemPrompt =
    "You are a helpful AI assistant. Be concise, direct, and write natural responses.";
  const basePrompt =
    userSettings?.agentSystemPrompt && userSettings.agentSystemPrompt.trim()
      ? userSettings.agentSystemPrompt
      : defaultSystemPrompt;

  // Conditionally append memory instruction only when memory tools are enabled
  const memoryInstruction =
    resolvedToolConfig.memory !== false
      ? "\n\nYou have a persistent memory system. If the user references something you don't know about, use `memory_search` to look it up before answering."
      : "";

  piSession.agent.state.systemPrompt = basePrompt + memoryInstruction;

  // Reconstruct conversation history from DB messages.
  // buildHistoryMessages ensures byte-identical output to the live agent:
  // - toolCallId (not toolUseId) for correct provider adapter mapping
  // - resolved model metadata for same-model detection in transformMessages
  // - canonical content block order: thinking → text → toolCall
  // - toolResult text extracted (not double-encoded)
  // - image attachments re-read from disk (deterministic WebP → base64)
  const storedMessages: StoredMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    toolCalls: m.toolCalls,
    attachments: m.attachments.map((a) => ({
      storagePath: a.storagePath,
      mimeType: a.mimeType,
    })),
  }));

  // Pre-load images for all user messages in history (not the last one — that's the current prompt).
  // This ensures byte-identical base64 data across turns → LLM cache hits.
  // Map from history index (0-based, excludes last message) to ImageContent[].
  const imageCache = new Map<number, ImageContent[]>();
  const historyMessagesSlice = storedMessages.slice(0, -1);
  for (let i = 0; i < historyMessagesSlice.length; i++) {
    const m = historyMessagesSlice[i]!;
    if (m.role === "user" && m.attachments && m.attachments.length > 0) {
      const images: ImageContent[] = [];
      for (const att of m.attachments) {
        try {
          const { data, mimeType } = await readImageAsBase64(authResult.user.id, att.storagePath);
          images.push({ type: "image" as const, data, mimeType });
        } catch (err) {
          console.error(`Failed to load image for history message ${i}:`, err);
        }
      }
      if (images.length > 0) {
        imageCache.set(i, images);
      }
    }
  }

  const historyMessages = buildHistoryMessages(storedMessages, {
    api: model?.api,
    provider: model?.provider,
    id: model?.id,
    imageCache,
  });

  // Pre-load images for the current (last) user message.
  // Must be done outside the stream's start() callback (which is not async).
  const lastMessageImages: ImageContent[] = [];
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === "user" && lastMessage.attachments.length > 0) {
    for (const att of lastMessage.attachments) {
      try {
        const { data, mimeType } = await readImageAsBase64(authResult.user.id, att.storagePath);
        lastMessageImages.push({ type: "image" as const, data, mimeType });
      } catch (err) {
        console.error("Failed to load image for current message:", err);
      }
    }
  }
  // Create SSE stream
  const encoder = new TextEncoder();
  let clientDisconnected = false;

  /**
   * Send an SSE event with proper escaping.
   * SSE spec: a line containing only "\n" terminates the event block.
   * JSON.stringify can produce \n inside strings (from tool results, etc.),
   * which would prematurely terminate the event and inject a new one.
   * We escape literal newlines in the JSON payload to prevent this.
   */
  function sendEvent(
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown,
  ): void {
    if (clientDisconnected) return;
    const json = JSON.stringify(data);
    // Replace literal newlines with \n to prevent SSE event termination
    const escaped = json.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${escaped}\n\n`));
  }

  // Track tool call results for the final message
  const toolCallResults: Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  > = new Map();

  // Track turn state
  let turnIndex = 0;
  let currentTurnText = "";
  let currentTurnThinking = "";
  // Track tool calls that belong to the current turn (by toolCallId)
  const currentTurnToolCallIds = new Set<string>();

  // Root assistant message ID (first turn's DB message id, used as parentMessageId for subsequent turns)
  let rootMessageId: string | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Inject conversation history into the agent state
      if (historyMessages.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentMessage type requires full AssistantMessage fields (api/provider/model/usage), but convertToLlm handles simple {role, content} objects at runtime
        piSession.agent.state.messages = historyMessages as any;
      }

      // Subscribe to agent events
      piSession.subscribe((event) => {
        switch (event.type) {
          case "message_update": {
            if (event.message.role !== "assistant") return;
            // Narrow to assistant message with content array
            const msg = event.message as { content: unknown[] };

            // Extract thinking content
            const thinkingBlock = msg.content.find(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "thinking",
            );
            if (thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock) {
              currentTurnThinking = (thinkingBlock as Record<string, unknown>).thinking as string;
              sendEvent(controller, "thinking", { thinking: currentTurnThinking });
            }

            // Extract cumulative text from all text blocks
            const textBlocks = msg.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "text",
            );
            currentTurnText = textBlocks
              .map((c) => ((c as Record<string, unknown>).text as string) || "")
              .join("");
            if (currentTurnText) {
              sendEvent(controller, "token", { text: currentTurnText });
            }

            // Track tool call IDs appearing in this message
            for (const content of msg.content) {
              if (
                typeof content === "object" &&
                content !== null &&
                (content as Record<string, unknown>).type === "toolCall"
              ) {
                currentTurnToolCallIds.add((content as Record<string, unknown>).id as string);
              }
            }
            break;
          }

          case "tool_execution_start": {
            toolCallResults.set(event.toolCallId, {
              name: event.toolName,
              args: event.args,
            });
            sendEvent(controller, "tool_start", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            });
            break;
          }

          case "tool_execution_end": {
            // Normalize result to string for consistent frontend typing.
            // Uses the same logic as buildHistoryMessages to ensure the stored
            // result matches what would be replayed — critical for cache hits.
            const resultStr = normalizeToolResult(event.result);
            const existing = toolCallResults.get(event.toolCallId);
            if (existing) {
              existing.result = resultStr;
              existing.isError = event.isError;
            }
            sendEvent(controller, "tool_end", {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: resultStr,
              isError: event.isError,
            });
            break;
          }

          case "turn_end": {
            // Collect tool calls for this turn from the message content
            // event.message is AgentMessage which may not have .content (e.g., BashExecutionMessage)
            // Narrow to messages that have content
            const assistantMsg =
              event.message.role === "assistant" ? (event.message as { content: unknown[] }) : null;
            const toolCallBlocks = assistantMsg
              ? (assistantMsg.content.filter(
                  (c) =>
                    typeof c === "object" &&
                    c !== null &&
                    (c as Record<string, unknown>).type === "toolCall",
                ) as Record<string, unknown>[])
              : [];
            const turnToolCalls = toolCallBlocks.map((tc) => {
              const result = toolCallResults.get(tc.id as string);
              return {
                id: tc.id as string,
                name: tc.name as string,
                args: tc.arguments as unknown as Record<string, unknown>,
                result: result?.result,
                isError: result?.isError,
              };
            });

            // Save this turn's message to DB
            const savedMessage = saveAssistantMessage(
              sessionId,
              currentTurnText,
              currentTurnThinking || undefined,
              turnToolCalls.length > 0 ? turnToolCalls : undefined,
              rootMessageId, // parentMessageId (null for first turn)
            );

            savedMessage.then((msg) => {
              if (!rootMessageId) {
                rootMessageId = msg.id;
              }
            });

            // Emit turn_end event to frontend
            sendEvent(controller, "turn_end", {
              turnIndex,
              text: currentTurnText,
              thinking: currentTurnThinking || null,
              toolCalls: turnToolCalls,
            });

            turnIndex++;
            currentTurnText = "";
            currentTurnThinking = "";
            currentTurnToolCallIds.clear();
            break;
          }

          case "agent_end": {
            // Get final assistant message(s)
            // Cast to access content property (AgentMessage is a union that includes non-content types)
            const assistantMessages = event.messages
              .filter((m) => m.role === "assistant")
              .map((m) => m as { role: "assistant"; content: unknown[] });
            const lastAssistant = assistantMessages[assistantMessages.length - 1];

            if (lastAssistant) {
              // Extract final text
              const textBlocks = lastAssistant.content.filter(
                (c) =>
                  typeof c === "object" &&
                  c !== null &&
                  (c as Record<string, unknown>).type === "text",
              );
              const finalText = textBlocks
                .map((c) => ((c as Record<string, unknown>).text as string) || "")
                .join("");

              // Extract thinking
              const thinkingBlock = lastAssistant.content.find(
                (c) =>
                  typeof c === "object" &&
                  c !== null &&
                  (c as Record<string, unknown>).type === "thinking",
              );
              const finalThinking =
                thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock
                  ? ((thinkingBlock as Record<string, unknown>).thinking as string)
                  : "";

              // Extract tool calls from the message content
              const toolCallBlocks = lastAssistant.content.filter(
                (c) =>
                  typeof c === "object" &&
                  c !== null &&
                  (c as Record<string, unknown>).type === "toolCall",
              ) as Record<string, unknown>[];
              const toolCalls = toolCallBlocks.map((tc) => {
                const result = toolCallResults.get(tc.id as string);
                return {
                  id: tc.id as string,
                  name: tc.name as string,
                  args: tc.arguments as unknown as Record<string, unknown>,
                  result: result?.result,
                  isError: result?.isError,
                };
              });

              // If there were no turn_end events (single-turn response with no tools),
              // save the message here
              if (turnIndex === 0) {
                saveAssistantMessage(
                  sessionId,
                  finalText,
                  finalThinking || undefined,
                  toolCalls.length > 0 ? toolCalls : undefined,
                  null,
                ).catch(console.error);
              }

              // Update message count and clear in-progress flag
              prisma.chatSession
                .update({
                  where: { id: sessionId },
                  data: {
                    messageCount: { increment: turnIndex || 1 },
                    processingSince: null,
                  },
                })
                .catch(console.error);
            }

            sendEvent(controller, "done", {});

            if (!clientDisconnected) {
              controller.close();
            }
            break;
          }
        }
      });

      // Send the user message to the agent
      // Use agent.prompt() directly to bypass AgentSession preflight logic
      // which resets systemPrompt back to the Pi base prompt on every turn
      if (lastMessage && lastMessage.role === "user") {
        const promptPromise =
          lastMessageImages.length > 0
            ? piSession.agent.prompt(lastMessage.content, lastMessageImages)
            : piSession.agent.prompt(lastMessage.content);
        promptPromise.catch((err) => {
          console.error("agent.prompt() failed:", err);
          // Clear in-progress flag so the user can retry
          prisma.chatSession
            .update({ where: { id: sessionId }, data: { processingSince: null } })
            .catch(console.error);
          sendEvent(controller, "error", { message: err.message });
          if (!clientDisconnected) {
            controller.close();
          }
        });
      }

      // Handle client disconnect — stop sending SSE events but let the agent
      // finish processing so messages are still saved to the database.
      // When the user navigates back, loadMessages() picks up the saved response.
      request.signal.addEventListener("abort", () => {
        clientDisconnected = true;
        controller.close();
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

async function saveAssistantMessage(
  sessionId: string,
  content: string,
  thinking?: string,
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result: string | undefined;
    isError: boolean | undefined;
  }>,
  parentMessageId?: string | null,
): Promise<{ id: string }> {
  return prisma.chatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
      thinking: thinking || null,
      toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      parentMessageId: parentMessageId || null,
    },
  });
}
