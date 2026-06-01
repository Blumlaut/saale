import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { headers } from "next/headers";
import { createPiSession } from "@/lib/pi/session";
import { mailTools } from "@/lib/pi/tools/mail-tools";
import { jobTools } from "@/lib/pi/tools/job-tools";

/**
 * GET /api/chat/sessions/:sessionId/stream — SSE streaming endpoint
 *
 * Streams Pi agent responses as Server-Sent Events.
 * Emits: token (cumulative text), thinking (cumulative thinking),
 *         tool_start, tool_end, tool_result, done
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
      toolCalls: true,
    },
  });

  // Create Pi session with custom tools
  const { session: piSession } = await createPiSession({
    userId: authSession.user.id,
    customTools: [...mailTools, ...jobTools],
    modelProvider: chatSession.modelProvider || undefined,
    modelName: chatSession.modelName || undefined,
    thinkingLevel: chatSession.thinkingLevel || "off",
  });

  // Set up system prompt
  piSession.agent.state.systemPrompt = `You are Saale, an AI assistant in a productivity hub. You help users with email management, task automation, and general questions.

You have access to tools for:
- Email: list, read, search, send, tag, move, and delete emails
- Jobs: list, enable/disable, run, and view logs for automated tasks
- Files: read, write, and manage files in the user's workspace (via built-in tools)

Always be concise and helpful. When using tools, explain what you're doing briefly.`;

  // Load conversation history into agent (all messages except the last user message,
  // because prompt() will add the last user message itself)
  // Assistant messages need proper usage fields to avoid totalTokens crash in compaction checks
  const historyMessages = messages
    .slice(0, -1)
    .map((m: { role: string; content: string; toolCalls: string | null }) => {
      const base = {
        role: m.role as "user" | "assistant",
        content: [{ type: "text", text: m.content }],
      };
      if (m.role === "assistant") {
        return {
          ...base,
          api: "openai-completions",
          provider: chatSession.modelProvider || "custom",
          model: chatSession.modelName || "unknown",
          stopReason: "end_turn",
          timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        };
      }
      return { ...base, timestamp: Date.now() };
    });

  // Create SSE stream
  const encoder = new TextEncoder();
  let aborted = false;

  // Track tool call results for the final message
  const toolCallResults: Map<
    string,
    { name: string; args: Record<string, unknown>; result?: string; isError?: boolean }
  > = new Map();

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

            // Extract thinking content
            const thinkingBlock = event.message.content.find(
              (c) => typeof c === "object" && c.type === "thinking",
            );
            if (thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock) {
              controller.enqueue(
                encoder.encode(
                  `event: thinking\ndata: ${JSON.stringify({
                    thinking: thinkingBlock.thinking as string,
                  })}\n\n`,
                ),
              );
            }

            // Extract cumulative text from all text blocks
            const textBlocks = event.message.content.filter(
              (c) => typeof c === "object" && c.type === "text",
            );
            const cumulativeText = textBlocks
              .map((c) => (typeof c === "object" && "text" in c ? (c.text as string) : ""))
              .join("");
            if (cumulativeText) {
              controller.enqueue(
                encoder.encode(
                  `event: token\ndata: ${JSON.stringify({
                    text: cumulativeText,
                  })}\n\n`,
                ),
              );
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
            const existing = toolCallResults.get(event.toolCallId);
            if (existing) {
              existing.result = event.result;
              existing.isError = event.isError;
            }
            controller.enqueue(
              encoder.encode(
                `event: tool_end\ndata: ${JSON.stringify({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  result: event.result,
                  isError: event.isError,
                })}\n\n`,
              ),
            );
            break;
          }

          case "agent_end": {
            // Get final assistant message
            const lastAssistant = event.messages.findLast((m) => m.role === "assistant");
            if (lastAssistant) {
              // Extract final text
              const textBlocks = lastAssistant.content.filter(
                (c) => typeof c === "object" && c.type === "text",
              );
              const finalText = textBlocks
                .map((c) => (typeof c === "object" && "text" in c ? (c.text as string) : ""))
                .join("");

              // Extract thinking
              const thinkingBlock = lastAssistant.content.find(
                (c) => typeof c === "object" && c.type === "thinking",
              );
              const finalThinking =
                thinkingBlock && typeof thinkingBlock === "object" && "thinking" in thinkingBlock
                  ? (thinkingBlock.thinking as string)
                  : "";

              // Extract tool calls from the message content
              const toolCallBlocks = lastAssistant.content.filter(
                (c) => typeof c === "object" && c.type === "toolCall",
              );
              const toolCalls = toolCallBlocks
                .map((c) => {
                  if (typeof c !== "object") return null;
                  const tc = c as unknown as Record<string, unknown>;
                  const result = toolCallResults.get(tc.id as string);
                  return {
                    id: tc.id as string,
                    name: tc.name as string,
                    args: tc.arguments as unknown as Record<string, unknown>,
                    result: result?.result,
                    isError: result?.isError,
                  };
                })
                .filter((t): t is NonNullable<typeof t> => t !== null);

              // Save assistant message to DB with tool calls
              saveAssistantMessage(sessionId, finalText, toolCalls).catch(console.error);

              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({
                    text: finalText,
                    thinking: finalThinking,
                    toolCalls,
                  })}\n\n`,
                ),
              );
            }

            controller.close();
            break;
          }
        }
      });

      // Send the user message to the agent
      const lastMessage = messages[messages.length - 1];
      if (lastMessage && lastMessage.role === "user") {
        piSession.prompt(lastMessage.content);
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
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  }>,
): Promise<void> {
  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
      toolCalls: toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
    },
  });

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { messageCount: { increment: 1 } },
  });
}
