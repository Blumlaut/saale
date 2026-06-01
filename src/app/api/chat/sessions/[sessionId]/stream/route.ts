import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { createPiSession, type ToolConfig } from "@/lib/pi/session";
import {
  normalizeToolResult,
  buildHistoryMessages,
  type StoredMessage,
} from "@/lib/pi/message-replay";

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
  const authSession = await auth.api.getSession({
    headers: await headers(),
  });

  if (!authSession?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { sessionId } = await params;

  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId: authSession.user.id },
    select: {
      id: true,
      modelProvider: true,
      modelName: true,
      thinkingLevel: true,
      toolConfig: true,
    },
  });

  if (!chatSession) {
    return new Response("Not found", { status: 404 });
  }

  // Get all messages for context
  const messages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      content: true,
      thinking: true,
      toolCalls: true,
      parentMessageId: true,
    },
  });

  // Create Pi session with custom tools (filtered by toolConfig)
  const { session: piSession } = await createPiSession({
    userId: authSession.user.id,
    customTools: [],
    ...(chatSession.toolConfig && { toolConfig: chatSession.toolConfig as ToolConfig }),
    ...(chatSession.modelProvider && { modelProvider: chatSession.modelProvider }),
    ...(chatSession.modelName && { modelName: chatSession.modelName }),
    thinkingLevel: chatSession.thinkingLevel || "off",
  });

  // Capture resolved model for consistent history reconstruction.
  // Using the actual model's api/provider/id ensures transformMessages treats
  // replayed messages as same-model (isSameModel=true), preserving thinking
  // blocks, tool signatures, etc. — critical for cache hits.
  const model = piSession.model;

  // Set up system prompt
  // Keep this minimal — no feature/tool descriptions. The agent infers capabilities from tools.
  // TODO: replace with user-defined system prompt from AppSettings/ChatSession when implemented
  piSession.agent.state.systemPrompt =
    "You are a helpful AI assistant. Be concise, direct, and write natural responses.";

  // Reconstruct conversation history from DB messages.
  // buildHistoryMessages ensures byte-identical output to the live agent:
  // - toolCallId (not toolUseId) for correct provider adapter mapping
  // - resolved model metadata for same-model detection in transformMessages
  // - canonical content block order: thinking → text → toolCall
  // - toolResult text extracted (not double-encoded)
  const storedMessages: StoredMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    toolCalls: m.toolCalls,
  }));
  const historyMessages = buildHistoryMessages(storedMessages, {
    api: model?.api,
    provider: model?.provider,
    id: model?.id,
  });

  // Create SSE stream
  const encoder = new TextEncoder();
  let aborted = false;

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
      const unsubscribe = piSession.subscribe((event) => {
        if (aborted) return;

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
              controller.enqueue(
                encoder.encode(
                  `event: thinking\ndata: ${JSON.stringify({
                    thinking: currentTurnThinking,
                  })}\n\n`,
                ),
              );
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
              controller.enqueue(
                encoder.encode(
                  `event: token\ndata: ${JSON.stringify({
                    text: currentTurnText,
                  })}\n\n`,
                ),
              );
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
            controller.enqueue(
              encoder.encode(
                `event: tool_start\ndata: ${JSON.stringify({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args,
                })}\n\n`,
              ),
            );
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
            controller.enqueue(
              encoder.encode(
                `event: tool_end\ndata: ${JSON.stringify({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  result: resultStr,
                  isError: event.isError,
                })}\n\n`,
              ),
            );
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
            controller.enqueue(
              encoder.encode(
                `event: turn_end\ndata: ${JSON.stringify({
                  turnIndex,
                  text: currentTurnText,
                  thinking: currentTurnThinking || null,
                  toolCalls: turnToolCalls,
                })}\n\n`,
              ),
            );

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

              // Update message count (count turns, not just root messages)
              prisma.chatSession
                .update({
                  where: { id: sessionId },
                  data: { messageCount: { increment: turnIndex || 1 } },
                })
                .catch(console.error);
            }

            controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({})}\n\n`));

            controller.close();
            break;
          }
        }
      });

      // Send the user message to the agent
      // Use agent.prompt() directly to bypass AgentSession preflight logic
      // which resets systemPrompt back to the Pi base prompt on every turn
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === "user") {
        piSession.agent.prompt(lastMessage.content);
      }

      // Handle client disconnect
      request.signal.addEventListener("abort", () => {
        aborted = true;
        unsubscribe();
        piSession.abort();
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
