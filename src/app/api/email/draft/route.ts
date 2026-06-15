import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  createAgentSession,
  SessionManager,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { buildModelRegistry } from "@/lib/pi/models";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";

/**
 * POST /api/email/draft — Generate an AI email draft reply
 *
 * Uses a dedicated system prompt (no Pi agent noise) for clean email drafting.
 * Streams the response via SSE: token (cumulative text), done
 *
 * Body: {
 *   messageId: string,    // original email to reply to
 *   mode: "reply" | "reply_all" | "forward",
 * }
 */
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;

  const body = await request.json();
  const { messageId, mode = "reply" } = body as {
    messageId: string;
    mode?: "reply" | "reply_all" | "forward";
  };

  if (!messageId) {
    return NextResponse.json({ error: "messageId is required" }, { status: 400 });
  }

  const message = await prisma.emailMessage.findFirst({
    where: {
      id: messageId,
      account: { userId: authResult.user.id },
    },
    select: {
      id: true,
      fromName: true,
      fromEmail: true,
      to: true,
      subject: true,
      bodyText: true,
      bodyHtml: true,
      bodyPreview: true,
      date: true,
    },
  });

  if (!message) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  // Build model registry with user's providers
  const { modelRegistry, authStorage } = await buildModelRegistry(authResult.user.id);

  // Resolve model for email_draft purpose (purpose override → global default)
  const modelInfo = await resolveModelForPurpose(authResult.user.id, "email_draft");

  let model;
  if (modelInfo) {
    model = modelRegistry.find(modelInfo.provider, modelInfo.name);
  }

  if (!model) {
    return NextResponse.json(
      { error: "No AI model configured. Set a default model in settings." },
      { status: 422 },
    );
  }

  // Create a lightweight agent session — no tools, no thinking, just text completion
  const result: CreateAgentSessionResult = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    noTools: "all",
    model,
    customTools: [],
    thinkingLevel: "off",
  });

  const { session: piSession } = result;

  // Fetch user's email writing style
  const emailSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.user.id },
    select: { emailWritingStyle: true },
  });

  // Custom system prompt — focused purely on email drafting, no Pi agent noise
  // Incorporate user's custom writing style if defined
  const modeInstruction =
    mode === "forward"
      ? `You are forwarding this email to someone else. Write a brief introductory note before the forwarded content. Do NOT include the original message body — only the intro note.`
      : `You are replying to this email. Write a natural response addressing the content of the original message.`;

  const userStyleInstructions =
    emailSettings?.emailWritingStyle && emailSettings.emailWritingStyle.trim()
      ? `\n\nWriting style (defined by user):
${emailSettings.emailWritingStyle}`
      : "";

  piSession.agent.state.systemPrompt = `You are an email drafting assistant. Your only job is to write clear, concise email responses.

${modeInstruction}
${userStyleInstructions}

Rules:
- Write only the email body text — no explanations, no meta-commentary
- Match the tone of the original message (professional, casual, urgent, etc.)
- Keep it concise and natural
- Do not include greetings like "Dear X" or sign-offs unless they match the original tone
- If the original message asks questions, answer them directly
- If the original message makes a request, acknowledge it clearly
- Output plain text only — no markdown formatting`;

  // Build the user prompt from the original email
  const originalBody = message.bodyText || message.bodyPreview || "";
  const fromName = message.fromName || message.fromEmail;
  const toField = typeof message.to === "string" ? message.to : JSON.stringify(message.to || "");

  const userPrompt =
    mode === "forward"
      ? `Forward this email:\n\nFrom: ${fromName} <${message.fromEmail}>\nSubject: ${message.subject}\n\n${originalBody}`
      : `Reply to this email:\n\nFrom: ${fromName} <${message.fromEmail}>\nTo: ${toField}\nSubject: ${message.subject}\n\n${originalBody}`;

  // Create SSE stream
  const encoder = new TextEncoder();
  let aborted = false;
  let currentText = "";

  /** Send an SSE event with proper newline escaping to prevent event injection. */
  function sendEvent(
    controller: ReadableStreamDefaultController,
    event: string,
    data: unknown,
  ): void {
    const json = JSON.stringify(data).replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    controller.enqueue(encoder.encode(`event: ${event}\ndata: ${json}\n\n`));
  }

  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = piSession.subscribe((event) => {
        if (aborted) return;

        if (event.type === "message_update" && event.message.role === "assistant") {
          const msg = event.message as { content: unknown[] };
          const textBlocks = msg.content.filter(
            (c) =>
              typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
          );
          currentText = textBlocks
            .map((c) => ((c as Record<string, unknown>).text as string) || "")
            .join("");
          if (currentText) {
            sendEvent(controller, "token", { text: currentText });
          }
        }

        if (event.type === "agent_end") {
          // Extract final text
          const assistantMessages = (
            event.messages as { role: string; content: unknown[] }[]
          ).filter((m) => m.role === "assistant");
          const lastAssistant = assistantMessages[assistantMessages.length - 1];

          let finalText = currentText;
          if (lastAssistant) {
            const textBlocks = lastAssistant.content.filter(
              (c) =>
                typeof c === "object" &&
                c !== null &&
                (c as Record<string, unknown>).type === "text",
            );
            finalText = textBlocks
              .map((c) => ((c as Record<string, unknown>).text as string) || "")
              .join("");
          }

          sendEvent(controller, "done", { text: finalText });
          controller.close();
        }
      });

      // Call agent.prompt directly to bypass AgentSession's preflight logic
      // which resets systemPrompt back to the Pi base prompt on every turn
      piSession.agent.prompt(userPrompt);

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
