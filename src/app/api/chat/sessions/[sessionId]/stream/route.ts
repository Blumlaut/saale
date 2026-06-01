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
 * The agent processes the latest user message and streams back tokens,
 * tool calls, and final response.
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
  const historyMessages = messages.slice(0, -1).map((m: { role: string; content: string }) => ({
    role: m.role as "user" | "assistant",
    content: [{ type: "text", text: m.content }],
  }));

  // Create SSE stream
  const encoder = new TextEncoder();
  let aborted = false;

  const stream = new ReadableStream({
    start(controller) {
      // Inject conversation history into the agent state
      if (historyMessages.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentMessage type is overly strict (requires full AssistantMessage fields like api/provider/model/usage), but the agent's convertToLlm handles simple {role, content} objects at runtime
        piSession.agent.state.messages = historyMessages as any;
      }

      // Subscribe to agent events
      const unsubscribe = piSession.subscribe((event) => {
        if (aborted) return;

        switch (event.type) {
          case "message_update": {
            // Stream assistant text tokens
            if (event.message.role === "assistant") {
              const textContent = event.message.content.find(
                (c) => typeof c === "object" && c.type === "text",
              );
              if (textContent && typeof textContent === "object" && "text" in textContent) {
                controller.enqueue(
                  encoder.encode(
                    `event: token\ndata: ${JSON.stringify({
                      text: textContent.text,
                    })}\n\n`,
                  ),
                );
              }
            }
            break;
          }

          case "tool_execution_start": {
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
              const textContent = lastAssistant.content.find(
                (c) => typeof c === "object" && c.type === "text",
              );
              const finalText =
                textContent && typeof textContent === "object" && "text" in textContent
                  ? textContent.text
                  : "";

              // Save assistant message to DB
              saveAssistantMessage(sessionId, finalText).catch(console.error);

              controller.enqueue(
                encoder.encode(
                  `event: done\ndata: ${JSON.stringify({
                    text: finalText,
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
        piSession.prompt(lastMessage.content, {
          streamingBehavior: "followUp",
        });
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

async function saveAssistantMessage(sessionId: string, content: string): Promise<void> {
  await prisma.chatMessage.create({
    data: {
      sessionId,
      role: "assistant",
      content,
    },
  });

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { messageCount: { increment: 1 } },
  });
}
