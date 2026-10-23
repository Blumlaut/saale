import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth";
import { attachTerminalRun, type TerminalRunEvent } from "@/lib/coder/terminal-runs";
import { createSseHeartbeat } from "@/lib/pi/sse-heartbeat";
import { formatSseEvent } from "@/lib/pi/stream-logic";

/**
 * GET /api/coder/sessions/:id/terminal/stream. watch the chat's terminal run.
 *
 * Server-sent events because output arrives for as long as the command runs. The
 * run belongs to the chat, so this connection is only a reader: closing it stops
 * nothing. A run that already printed replays before the live output starts, so
 * reopening the panel shows what happened while it was closed.
 */

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Quiet enough for a long build, busy enough that a proxy keeps the pipe. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const authResult = await requireSession();
  if (!authResult.ok) return authResult.response;
  const userId = authResult.user.id;

  const { sessionId } = await params;
  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const heartbeat = createSseHeartbeat(controller, SSE_HEARTBEAT_INTERVAL_MS);
      let closed = false;

      const finish = () => {
        if (closed) return;
        closed = true;
        heartbeat.stop();
        try {
          controller.close();
        } catch (err) {
          console.warn(`Terminal stream for chat ${sessionId} was already closed:`, err);
        }
      };

      const send = (event: string, payload: TerminalRunEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event, payload)));
        } catch (err) {
          // The client left; the run carries on without it.
          console.warn(`Terminal stream for chat ${sessionId} closed early:`, err);
          detach?.();
          finish();
        }
      };

      const attachment = attachTerminalRun(userId, sessionId, (event) => {
        send(event.type, event);
        if (event.type === "exit" || event.type === "error") finish();
      });

      // No run to show: the panel is idle, and an open connection would only
      // keep a proxy waiting.
      if (!attachment) {
        finish();
        return;
      }

      detach = attachment.detach;
      if (!attachment.live) finish();
    },
    cancel() {
      detach?.();
      detach = null;
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
