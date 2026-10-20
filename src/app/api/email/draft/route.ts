import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { SessionManager, type CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { buildModelRuntime } from "@/lib/pi/models";
import { createSystemPromptLoader } from "@/lib/pi/processing-state";
import { createSaaleAgentSession } from "@/lib/pi/agent-session";
import { resolveModelForPurpose } from "@/lib/pi/model-resolution";
import { createAgentIdleTimeout } from "@/lib/pi/agent-idle-timeout";
import { extractProviderError, type ProviderErrorSource } from "@/lib/pi/provider-error";

/**
 * POST /api/email/draft. Generate an AI email draft reply
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

  // Build model runtime with user's providers
  const { modelRuntime } = await buildModelRuntime(authResult.user.id);

  // Resolve model for email_draft purpose (purpose override → global default)
  const modelInfo = await resolveModelForPurpose(authResult.user.id, "email_draft");

  let model;
  if (modelInfo) {
    model = modelRuntime.getModel(modelInfo.provider, modelInfo.name);
  }

  if (!model) {
    return NextResponse.json(
      { error: "No AI model configured. Set a default model in settings." },
      { status: 422 },
    );
  }

  // Fetch user's email writing style
  const emailSettings = await prisma.appSettings.findUnique({
    where: { userId: authResult.user.id },
    select: { emailWritingStyle: true },
  });

  // Custom system prompt. focused purely on email drafting, no Pi agent noise
  // Incorporate user's custom writing style if defined
  const modeInstruction =
    mode === "forward"
      ? `You are forwarding this email to someone else. Write a brief introductory note before the forwarded content. Do NOT include the original message body. only the intro note.`
      : `You are replying to this email. Write a natural response addressing the content of the original message.`;

  const userStyleInstructions =
    emailSettings?.emailWritingStyle && emailSettings.emailWritingStyle.trim()
      ? `\n\nWriting style (defined by user):
${emailSettings.emailWritingStyle}`
      : "";

  const emailSystemPrompt = `You are an email drafting assistant. Your only job is to write clear, concise email responses.

${modeInstruction}
${userStyleInstructions}

Rules:
- Write only the email body text. no explanations, no meta-commentary
- Match the tone of the original message (professional, casual, urgent, etc.)
- Keep it concise and natural
- Do not include greetings like "Dear X" or sign-offs unless they match the original tone
- If the original message asks questions, answer them directly
- If the original message makes a request, acknowledge it clearly
- Output plain text only. no markdown formatting`;

  // Create a lightweight agent session. no tools, no thinking, just text completion
  const result: CreateAgentSessionResult = await createSaaleAgentSession(authResult.user.id, {
    sessionManager: SessionManager.inMemory(),
    modelRuntime,
    noTools: "all",
    model,
    customTools: [],
    resourceLoader: await createSystemPromptLoader(emailSystemPrompt, process.cwd()),
    thinkingLevel: "off",
  });

  const { session: piSession } = result;

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

  /** Text blocks of an assistant message's content array. */
  function extractText(content: unknown[]): string {
    return content
      .filter(
        (c): c is Record<string, unknown> =>
          typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text",
      )
      .map((c) => (c.text as string) || "")
      .join("");
  }

  const stream = new ReadableStream({
    start(controller) {
      /** Idle window. a hung provider must not leave the stream open forever. */
      const IDLE_TIMEOUT_MS = 10 * 60_000;
      let finished = false;

      /**
       * End the response exactly once, whatever the outcome. The listener, the
       * idle timer and the session must all go: a disposed session aborts the
       * agent and cancels the cache warmer.
       */
      const close = (event: string, data: unknown) => {
        if (finished || aborted) return;
        finished = true;
        idleTimeout.clear();
        unsubscribe();
        piSession.dispose();
        sendEvent(controller, event, data);
        controller.close();
      };

      const fail = (message: string) => {
        console.error(`[email:${messageId}] Draft generation failed:`, message);
        close("error", { error: message });
      };

      const idleTimeout = createAgentIdleTimeout({
        session: piSession,
        timeoutMs: IDLE_TIMEOUT_MS,
        label: `email-draft:${messageId}`,
        onTimeout: () => {
          piSession.abort().catch((err) => {
            console.error(`[email:${messageId}] Failed to abort stalled draft:`, err);
          });
          fail("Draft generation stalled (no activity for 10min)");
        },
      });

      /** Outcome of the last finished attempt (see the `agent_end` case). */
      let lastAttemptError: string | null = null;
      let lastAttemptText = "";

      const unsubscribe = piSession.subscribe((event) => {
        if (aborted || finished) return;

        if (event.type === "message_update" && event.message.role === "assistant") {
          const text = extractText((event.message as { content: unknown[] }).content);
          currentText = text;
          if (text) {
            sendEvent(controller, "token", { text });
          }
        }

        // One report per attempt: `agent_end` fires before any retry, and an
        // overflow failure (`willRetry: false`) is followed by a
        // compact-and-continue. so the final attempt is what counts.
        if (event.type === "agent_end" && !event.willRetry) {
          const lastAssistant = [...event.messages]
            .reverse()
            .find((m) => m.role === "assistant") as ProviderErrorSource | undefined;
          lastAttemptError = extractProviderError(lastAssistant);
          lastAttemptText = lastAssistant
            ? extractText((lastAssistant as { content: unknown[] }).content)
            : "";
        }

        // Only `agent_settled`. after retries, compaction and any continuation
        //. means the draft is complete. Closing on `agent_end` reported failed
        // or truncated drafts as successful empty ones.
        if (event.type === "agent_settled") {
          if (lastAttemptError && !lastAttemptText) {
            fail(lastAttemptError);
            return;
          }
          close("done", { text: lastAttemptText || currentText });
        }
      });

      // session.prompt(). not session.agent.prompt(). runs the SDK's preflight
      // and post-run processing (retries, overflow recovery, `agent_settled`).
      // The per-turn system prompt comes from the resource loader, so switching
      // to it does not reset the prompt the way agent.prompt() was thought to.
      piSession.prompt(userPrompt, { expandPromptTemplates: false }).catch((err: Error) => {
        fail(err.message);
      });

      // Handle client disconnect
      request.signal.addEventListener("abort", () => {
        aborted = true;
        idleTimeout.clear();
        unsubscribe();
        piSession.abort().catch((err) => {
          console.error(`[email:${messageId}] Failed to abort draft on disconnect:`, err);
        });
        piSession.dispose();
        try {
          controller.close();
        } catch (err) {
          // The client is already gone; a closed controller is expected.
          console.error(`[email:${messageId}] Failed to close aborted stream:`, err);
        }
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
